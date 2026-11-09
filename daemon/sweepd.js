#!/usr/bin/env node
'use strict';
// sweepd: background service for the Sweep app. Holds the robot's single
// local connection, records mission history, runs automations, sends
// desktop alerts, and serves an HTTP + Server-Sent Events API on localhost.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { Robot } = require('./robot');
const { Store } = require('./db');
const { MissionTracker, finalizeCounters } = require('./missions');
const { readSettings, buildDelta } = require('./settings');
const { evaluate, robotHolds, nextScheduled, inQuietHours, validate } = require('./automations');
const robotsched = require('./robotsched');
const { Presence } = require('./presence');
const { Alerts } = require('./alerts');
const describe = require('./describe');
const rooms = require('./rooms');
const maintenance = require('./maintenance');
const insights = require('./insights');
const { Cloud } = require('./cloud');
const umf = require('./umf');

const VERSION = '0.6.0';
const PORT = Number(process.env.SWEEP_PORT) || 8099;
const CONFIG = process.env.SWEEP_CONFIG || path.join(os.homedir(), '.config', 'sweep', 'config.json');
const DB = process.env.SWEEP_DB || path.join(os.homedir(), '.local', 'share', 'sweep', 'sweep.db');
const startedAt = Date.now();

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a)
};

const store = new Store(DB);
const alerts = new Alerts(store, log);
const tracker = new MissionTracker(store.openMission());
const clients = new Set();

let cfg = null; let configError = null;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!cfg.ip || !cfg.blid || !cfg.password) throw new Error('config needs ip, blid and password');
} catch (e) { configError = `${CONFIG}: ${e.message}`; log.error(configError); }

const robot = new Robot(cfg || {}, log);
// iRobot cloud access, for the map only; set up with bin/sweep-cloud-login.
const cloud = cfg && cfg.cloudEmail ? new Cloud({ email: cfg.cloudEmail, country: cfg.cloudCountry || 'US', log }) : null;
const CLOUD_CACHE = path.join(path.dirname(DB), 'cloud');

// ---------- broadcasting ----------
function broadcast (event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function record (kind, message, data) {
  const e = store.logEvent(kind, message, data);
  log.info(`[${kind}] ${message}`);
  broadcast('log', e);
  return e;
}

function safeWarnings () { try { return currentWarnings(); } catch (e) { return []; } }
function roomStore () { return store.get('rooms', rooms.EMPTY); }

// ---------- map (from iRobot's cloud) ----------
function mapData () { return store.get('map', null); }
function mapView () { return { rotate: 0, mirror: false, ...store.get('mapView', {}) }; }

// Make every room and zone on the map known to Sweep, named as in the
// iRobot app, and use the map version the app uses for room cleans.
function syncRoomsFromMap (map, pmapId, userVersion) {
  const r = roomStore();
  const s = { ...rooms.EMPTY, ...r, rooms: [...(r.rooms || [])] };
  if (s.pmapId && s.pmapId !== pmapId) s.rooms = [];
  s.pmapId = pmapId;
  if (userVersion) s.version = userVersion;
  const st = robot.state;
  const defaultParams = st.noAutoPasses != null ? { noAutoPasses: !!st.noAutoPasses, twoPass: !!st.twoPass } : null;
  const changes = [];
  for (const area of [...map.rooms.map((x) => ({ ...x, type: 'rid' })), ...map.zones.map((x) => ({ ...x, type: 'zid' }))]) {
    let room = s.rooms.find((x) => rooms.roomKey(x) === area.key);
    if (!room) {
      room = { id: area.id, type: area.type, name: area.name || null, params: defaultParams, seenAt: Date.now() };
      s.rooms.push(room);
      changes.push(`added ${area.name || area.key}`);
    } else if (area.name && room.name !== area.name) { changes.push(`${room.name || area.key} → ${area.name}`); room.name = area.name; }
  }
  store.set('rooms', s);
  if (changes.length) record('rooms', `Rooms updated from the map: ${changes.join(', ')}`);
}

let mapRefreshing = null;
async function refreshMap ({ force = false } = {}) {
  if (!cloud) return null;
  if (mapRefreshing) return mapRefreshing;
  mapRefreshing = (async () => {
    const list = await cloud.pmaps(cfg.blid);
    const known = roomStore().pmapId;
    const p = list.find((x) => x.pmap_id === known) || list[0];
    if (!p) throw new Error('no saved map in the iRobot account');
    let map = mapData();
    if (force || !map || map.id !== p.pmap_id || map.version !== p.active_pmapv_id) {
      map = { ...umf.parseMap(await cloud.umf(cfg.blid, p.pmap_id, p.active_pmapv_id)), fetchedAt: Date.now() };
      store.set('map', map);
      log.info(`map ${map.name} ${map.version} loaded`);
    }
    syncRoomsFromMap(map, p.pmap_id, p.user_pmapv_id);
    syncRobotSchedules();
    await refreshHistory();
    broadcast('map', { version: map.version });
    pushStatus();
    return map;
  })().finally(() => { mapRefreshing = null; });
  return mapRefreshing;
}

// Attach each cloud mission record (map version, area) to Sweep's mission.
async function refreshHistory () {
  const history = await cloud.missionHistory(cfg.blid, 40);
  const missions = store.missions({ limit: 200 });
  for (const [id, rec] of umf.matchHistory(missions, history)) {
    const m = missions.find((x) => x.id === id);
    const changed = JSON.stringify(m.cloud) !== JSON.stringify(rec) || (rec.sqft && !m.sqft);
    if (!changed) continue;
    m.cloud = rec;
    if (rec.sqft && !m.sqft) m.sqft = rec.sqft;
    store.saveMission(m);
  }
}

async function coverageFor (missionId) {
  const m = store.mission(missionId);
  if (!m) throw Object.assign(new Error('unknown mission'), { status: 404 });
  if (!m.cloud || !m.cloud.version) throw Object.assign(new Error('no cloud map for this mission yet'), { status: 404 });
  const file = path.join(CLOUD_CACHE, `coverage-${m.cloud.version}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const cov = umf.parseCoverage(await cloud.umf(cfg.blid, m.cloud.pmapId, m.cloud.version));
  fs.mkdirSync(CLOUD_CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cov));
  return cov;
}

function mapRefreshSoon (delayMs) {
  if (!cloud) return;
  setTimeout(() => refreshMap().catch((e) => log.error('map refresh failed:', e.message)), delayMs);
}
function routines () { return store.get('routines', []); }
function maintRecords () { return store.get('maintenance', {}); }

// Start counting maintenance from the first time we see the counters, then
// announce items as they come due (once each, until marked done).
function checkMaintenance () {
  const { records, changed } = maintenance.ensureBaselines(maintRecords(), robot.state);
  let recs = records;
  const due = maintenance.newlyDue(recs, robot.state);
  for (const item of due) {
    recs = { ...recs, [item.key]: { ...recs[item.key], notifiedAt: Date.now() } };
    record('maintenance', `Maintenance due: ${item.label}`, { key: item.key });
  }
  if (changed || due.length) store.set('maintenance', recs);
  if (due.length) {
    alerts.send('maintenance', due.length === 1 ? 'Maintenance due' : `${due.length} maintenance items due`,
      due.map((d) => d.label).join(' · '), { cooldownMs: 0 });
    pushStatus();
  }
}

// Learn rooms from room cleans the iRobot app starts (see rooms.js).
let lastSeenCommandTime = null;
function captureRooms (cmd) {
  if (!cmd || cmd.time === lastSeenCommandTime || !rooms.isFromApp(cmd)) return;
  lastSeenCommandTime = cmd.time;
  const seen = rooms.extractRooms(cmd);
  if (!seen) return;
  const { store: next, added, mapChanged } = rooms.mergeRooms(roomStore(), seen);
  store.set('rooms', next);
  if (mapChanged) record('rooms', 'The robot is using a different map; room names were reset');
  for (const key of added) {
    const reg = seen.regions.find((r) => r.key === key);
    record('rooms', `Found a new ${reg.type === 'zid' ? 'clean zone' : 'room'} (#${key}); name it on the Rooms page`, { id: key });
  }
  if (added.length || mapChanged) broadcast('rooms', next);
}

function quiet () { return store.get('quiet', { enabled: false, start: '22:00', end: '08:00' }); }

// Rooms are shown with their current names (they may have been renamed since).
function withRoomNames (m) {
  if (!m || !Array.isArray(m.rooms)) return m;
  const st = roomStore();
  return { ...m, rooms: m.rooms.map((r) => ({ ...r, name: rooms.findRoom(st, r.id) ? rooms.roomName(st, r.id) : r.name })) };
}

function missionSummary (m) {
  if (!m) return null;
  const { countersStart, countersEnd, ...rest } = withRoomNames(m);
  return rest;
}

function statusPayload () {
  return describe.status(robot, {
    configError,
    daemon: { version: VERSION, startedAt },
    mission: missionSummary(tracker.current),
    presence: presence.state(),
    quiet: quiet(),
    quietNow: inQuietHours(Date.now(), quiet()),
    next: nextScheduled(store.automations(), Date.now()),
    countersUpdated: robot.lastFullAt || null,
    rooms: roomStore().rooms.map((r) => ({ id: rooms.roomKey(r), type: r.type, name: r.name, passes: rooms.roomPasses(r) })),
    routines: routines(),
    robotSchedule: {
      entries: Array.isArray(robot.state.cleanSchedule2) ? robot.state.cleanSchedule2.length : null,
      fromSweep: store.get('robotSchedWritten', []).length,
      paused: !!robot.state.schedHold,
      hold: store.get('robotHold', null)
    },
    map: cloud ? { configured: true, name: (mapData() || {}).name || null, version: (mapData() || {}).version || null, error: cloud.lastError } : { configured: false },
    warnings: safeWarnings().map((w) => ({ key: w.key, level: w.level, title: w.title })),
    maintenanceDue: maintenance.status(maintRecords(), robot.state).filter((x) => x.due).map((x) => ({ key: x.key, label: x.label }))
  });
}

let statusTimer = null;
function pushStatus () {
  // Updates arrive in bursts; coalesce them.
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = null; broadcast('status', statusPayload()); }, 150);
}

// ---------- missions, samples, alerts ----------
let lastBinFull = null; let lastSampleAt = 0;

function sample (force = false) {
  const s = robot.state; const m = s.cleanMissionStatus || {};
  const now = Date.now();
  if (!force && now - lastSampleAt < 5000) return;
  lastSampleAt = now;
  store.addSample({ t: now, battery: s.batPct, rssi: s.signal && s.signal.rssi, phase: m.phase, mission: tracker.current ? tracker.current.id : null });
}

async function finishMission (m) {
  store.saveMission(m);
  record('mission', `Mission ended (${m.result})`, { id: m.id });
  // Let the robot settle on the dock, then reconnect for fresh counters.
  await new Promise((resolve) => setTimeout(resolve, 8000));
  try {
    const state = await robot.refresh();
    finalizeCounters(m, state);
    // This firmware never updates the live mission timer locally; the
    // lifetime cleaning-time counter does advance, so use its difference.
    if (!m.missionMinutes && m.stats.cleanMinutes) m.missionMinutes = m.stats.cleanMinutes;
    checkMaintenance();
    store.saveMission(m);
  } catch (e) { log.error('counter refresh failed:', e.message); }
  reviewAndFollowUp(m);
  // The cloud gets the mission's map and coverage a little after it ends.
  mapRefreshSoon(3 * 60000);
  broadcast('mission', missionSummary(m));
  const st = m.stats || {};
  const mins = m.missionMinutes || Math.round((m.end - m.start) / 60000);
  const parts = [`${mins} min`];
  if (m.sqft) parts.push(`${m.sqft} sq ft`);
  if (st.bumps != null) parts.push(`${st.bumps} bumps`);
  if (m.batteryStart != null && m.batteryMin != null) parts.push(`battery ${m.batteryStart}% → ${m.batteryMin}%`);
  const title = m.result === 'completed' ? 'Cleaning finished' : m.result === 'error' ? 'Cleaning ended with an error' : 'Cleaning stopped';
  // A poor clean gets its own, more useful notification instead.
  if (!(m.review && m.review.verdict === 'poor')) alerts.send('finished', title, parts.join(' · '), { cooldownMs: 0 });
  checkWarnings();
}

// --- The "smarter brain": judge each clean, retry poor ones, watch for wear ---

function reviewSettings () { return { autoRetry: false, ...store.get('review', {}) }; }
let pendingRetryOf = null;

function reviewAndFollowUp (m) {
  if (!m.end) return;
  const history = store.missions({ limit: 300 }).filter((x) => x.end && x.id !== m.id);
  m.review = insights.reviewMission(m, history, { evacAllowed: robot.state.evacAllowed !== false });
  store.saveMission(m);
  if (m.review.verdict !== 'poor') return;
  const where = (m.rooms || []).map((r) => r.name).join(', ') || 'the clean';
  record('review', `Poor clean (${where}): ${m.review.reasons.join(' ')}`, { id: m.id });
  alerts.send('review', `${where} wasn't cleaned well`, m.review.reasons[0] + (m.review.advice[0] ? ` ${m.review.advice[0]}` : ''), { cooldownMs: 0 });

  // Optionally try once more with two passes, never for a retry itself.
  const cfg = reviewSettings();
  if (cfg.autoRetry && m.rooms && m.rooms.length && !m.retryOf && !inQuietHours(Date.now(), quiet())) {
    pendingRetryOf = m.id;
    setTimeout(() => {
      cleanRoomList(m.rooms.map((r) => r.id), 'Retry with two passes', { passes: 'two' })
        .catch((e) => { pendingRetryOf = null; record('review', `Couldn't retry ${where}: ${e.message}`); });
    }, 60000);
  }
}

// Review finished missions from before this feature existed.
function backfillReviews () {
  const all = store.missions({ limit: 1000 }).filter((x) => x.end).reverse();
  const history = [];
  for (const m of all) {
    if (!m.review && m.stats) { m.review = insights.reviewMission(m, history); store.saveMission(m); }
    history.push(m);
  }
}

function currentWarnings () {
  const since = Date.now() - 30 * 86400000;
  const missions = store.missions({ limit: 500, since }).filter((x) => x.end);
  const snapshots = [];
  for (const m of missions) {
    if (m.countersEnd) snapshots.push({ t: m.end, counters: m.countersEnd });
    if (m.countersStart) snapshots.push({ t: m.start, counters: m.countersStart });
  }
  snapshots.sort((a, b) => b.t - a.t);
  return insights.healthWarnings({ state: robot.state, missions, snapshots, samples: store.samples({ since: Date.now() - 86400000 }) });
}

// Notify about each warning at most once a week.
function checkWarnings () {
  try {
    const sent = store.get('warningsNotified', {});
    const now = Date.now();
    for (const w of currentWarnings()) {
      if (w.level !== 'warn' || (sent[w.key] && now - sent[w.key] < 7 * 86400000)) continue;
      sent[w.key] = now;
      record('health', `${w.title}: ${w.detail}`, { key: w.key });
      alerts.send('health', w.title, `${w.detail} ${w.advice}`, { cooldownMs: 0 });
    }
    store.set('warningsNotified', sent);
  } catch (e) { log.error('warning check failed:', e.message); }
}

robot.on('update', (reported, state) => {
  if (reported.lastCommand) captureRooms(reported.lastCommand);
  for (const ev of tracker.feed(state)) {
    const m = ev.mission;
    if (ev.type === 'start') {
      if (pendingRetryOf) { m.retryOf = pendingRetryOf; pendingRetryOf = null; }
      if (m.initiator === 'schedule') creditRobotSchedule(m);
      // Remember which rooms were asked for, if this mission was a room clean.
      const asked = rooms.extractRooms(state.lastCommand);
      if (asked && Math.abs(asked.time * 1000 - m.start) < 5 * 60000) {
        m.rooms = asked.regions.map((r) => ({ id: r.key, name: rooms.roomName(roomStore(), r.key) }));
      }
    }
    if (ev.type === 'start') { store.saveMission(m); record('mission', `Mission started by ${m.initiator || 'unknown'}`, { id: m.id }); broadcast('mission', missionSummary(m)); }
    if (ev.type === 'phase') { store.saveMission(m); broadcast('mission', missionSummary(m)); }
    if (ev.type === 'error') {
      const text = describe.errorText(ev.code);
      store.saveMission(m);
      record('error', `Error ${ev.code}: ${text}`, { id: m.id, code: ev.code });
      alerts.send('stuck', `${state.name || 'Roomba'} needs help`, text, { urgency: 'critical', cooldownMs: 60000 });
    }
    if (ev.type === 'end') finishMission(m).catch((e) => log.error(e));
  }

  if (state.bin) {
    if (state.bin.full && lastBinFull === false) {
      record('bin', 'Bin full');
      alerts.send('binFull', 'Bin is full', 'Empty the bin so cleaning can continue.');
    }
    lastBinFull = !!state.bin.full;
  }
  const m = state.cleanMissionStatus || {};
  if (reported.batPct != null && reported.batPct <= 15 && m.phase && !['charge', 'hmMidMsn', 'hmUsrDock', 'hmPostMsn'].includes(m.phase)) {
    alerts.send('lowBattery', 'Battery low', `${reported.batPct}% and not on the dock.`, { cooldownMs: 30 * 60000 });
  }
  if (tracker.current) sample();
  pushStatus();
});

let offlineSince = null;
// A mission the robot started from its own schedule: credit the matching rule.
function creditRobotSchedule (m) {
  const d = new Date(m.start);
  const minute = d.getHours() * 60 + d.getMinutes();
  for (const rule of store.automations()) {
    const c = rule.config || {};
    if (rule.type !== 'schedule' || !c.onRobot) continue;
    const t = /^(\d{1,2}):(\d{2})$/.exec(c.time || '');
    const days = Array.isArray(c.days) && c.days.length ? c.days : [0, 1, 2, 3, 4, 5, 6];
    if (!t || !days.includes(d.getDay()) || Math.abs(Number(t[1]) * 60 + Number(t[2]) - minute) > 2) continue;
    m.automation = { id: rule.id, name: rule.name };
    store.markAutomationRun(rule.id, m.start);
    record('automation', `Robot schedule “${rule.name}” started on the robot`, { ruleId: rule.id });
    return;
  }
}

let fullSyncTimer = null;
robot.on('full', () => {
  // The robot's schedule list arrives with the full state; check it soon after.
  clearTimeout(fullSyncTimer);
  fullSyncTimer = setTimeout(() => syncRobotSchedules(), 3000);
});

robot.on('full', () => { try { checkMaintenance(); } catch (e) { log.error('maintenance check failed:', e.message); } });

robot.on('connection', (up) => {
  if (up) {
    if (offlineSince && Date.now() - offlineSince > 60000) record('connection', 'Robot connection restored');
    offlineSince = null;
  } else if (!robot.refreshing) {
    offlineSince = offlineSince || Date.now();
  }
  pushStatus();
});

// ---------- automations ----------
const presence = new Presence(store, (home) => {
  record('presence', home ? 'Someone came home' : 'Everyone left');
  tick().catch((e) => log.error(e));
  pushStatus();
});

// ---------- schedules stored on the robot ----------
// Sweep's "run on the robot" schedules live in the robot's own list
// (cleanSchedule2), so they run even with this laptop off. The list also
// holds the iRobot app's schedules; Sweep keeps those and replaces only the
// entries it wrote last time.
let syncing = null; let syncAgain = false;
function syncRobotSchedules () {
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    if (!robot.connected || !Array.isArray(robot.state.cleanSchedule2)) return;
    const { entries, errors } = robotsched.desiredEntries(store.automations(), roomStore(), routines());
    for (const e of errors) record('automation', `Couldn't put a schedule on the robot: ${e.error}`, { ruleId: e.ruleId });
    const desired = entries.map((e) => e.entry);
    const current = robot.state.cleanSchedule2;
    const written = store.get('robotSchedWritten', []);
    const { list, foreign } = robotsched.merge(current, written, desired);
    if (robotsched.same(list, current)) { store.set('robotSchedWritten', desired); return; }
    await robot.setPreferences({ cleanSchedule2: list });
    for (let waited = 0; waited < 10000 && !robotsched.same(robot.state.cleanSchedule2, list); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!robotsched.same(robot.state.cleanSchedule2, list)) throw new Error('the robot did not confirm the new schedule list');
    store.set('robotSchedWritten', desired);
    record('automation', `Robot schedule updated: ${desired.length} from Sweep${foreign.length ? `, ${foreign.length} from the iRobot app kept` : ''}`);
    pushStatus();
  })().catch((e) => record('automation', `Couldn't update the robot's schedule: ${e.message}`))
    .finally(() => { syncing = null; if (syncAgain) { syncAgain = false; syncRobotSchedules(); } });
  return syncing;
}

// While Sweep runs, conditions still apply to robot schedules: pause the
// robot's schedules just before a run that should be skipped, then resume.
async function applyRobotHolds (ctx) {
  if (!robot.connected) return;
  const hold = store.get('robotHold', null);
  if (hold && ctx.now >= hold.until) {
    await robot.setPreferences({ schedHold: false });
    store.set('robotHold', null);
    record('automation', 'Robot schedules resumed');
    return;
  }
  if (hold) return;
  const holds = robotHolds(store.automations(), ctx);
  if (!holds.length) return;
  await robot.setPreferences({ schedHold: true });
  store.set('robotHold', { until: Math.max(...holds.map((h) => h.until)), rules: holds.map((h) => h.rule.id) });
  for (const h of holds) {
    store.markAutomationRun(h.rule.id, ctx.now);
    record('automation', `Skipping robot schedule “${h.rule.name}” at ${h.rule.config.time}: ${h.reason}`, { ruleId: h.rule.id });
  }
  pushStatus();
}

async function tick () {
  const s = robot.state; const m = s.cleanMissionStatus || {};
  const ctx = {
    now: Date.now(),
    connected: robot.connected,
    active: !!(m.cycle && m.cycle !== 'none'),
    battery: s.batPct ?? null,
    lastCleanEnd: store.lastCompletedEnd(),
    presence: presence.state(),
    quiet: quiet()
  };
  await applyRobotHolds(ctx).catch((e) => log.error('robot schedule hold failed:', e.message));
  const { fired, skipped } = evaluate(store.automations(), ctx);
  for (const { rule, reason, trigger } of skipped) {
    store.markAutomationRun(rule.id, ctx.now);
    record('automation', `Skipped “${rule.name}” (${trigger}): ${reason}`, { ruleId: rule.id });
  }
  for (const { rule, action, reason } of fired) {
    store.markAutomationRun(rule.id, ctx.now);
    try {
      const cfg = rule.config || {};
      const routine = cfg.routineId ? routines().find((x) => x.id === cfg.routineId) : null;
      if (cfg.routineId && !routine) throw new Error('its routine no longer exists');
      const roomIds = action !== 'start' ? [] : routine ? routine.rooms : Array.isArray(cfg.rooms) ? cfg.rooms : [];
      if (roomIds.length) await robot.cleanRooms(rooms.buildCleanArgs(roomStore(), robot.state.pmaps, roomIds, { ordered: true }));
      else await robot.command(action);
      const what = roomIds.length ? `cleaning ${roomIds.map((id) => rooms.roomName(roomStore(), id)).join(', ')}` : action;
      record('automation', `“${rule.name}” started ${what} (${reason})`, { ruleId: rule.id, action });
      alerts.send('automation', `Automation: ${rule.name}`, `Sent ${action} (${reason}).`, { cooldownMs: 0 });
    } catch (e) {
      record('automation', `“${rule.name}” failed to send ${action}: ${e.message}`, { ruleId: rule.id, action });
    }
  }
  if (fired.length || skipped.length) pushStatus();
}

// ---------- HTTP API ----------
function json (res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON')); } });
  });
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route('GET', /^\/api\/status$/, () => statusPayload());
route('GET', /^\/api\/health$/, () => describe.health(robot));
route('GET', /^\/api\/settings$/, () => ({ settings: readSettings(robot.state), robotSchedule: robot.state.cleanSchedule2 || null }));
route('PUT', /^\/api\/settings$/, async (req, body) => {
  const delta = buildDelta(body);
  await robot.setPreferences(delta);
  record('settings', `Changed ${Object.keys(body).join(', ')}`, body);
  // The robot takes several seconds to report a change; wait until it does.
  const applied = () => Object.entries(body).every(([k, v]) => readSettings(robot.state)[k].value === v);
  for (let waited = 0; waited < 10000 && !applied(); waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  return { settings: readSettings(robot.state), confirmed: applied() };
});
route('POST', /^\/api\/cmd\/(\w+)$/, async (req, body, [cmd]) => {
  await robot.command(cmd);
  record('command', `Sent ${cmd}`);
  return { ok: true, cmd };
});
route('POST', /^\/api\/refresh$/, async () => { await robot.refresh(); pushStatus(); return { ok: true, countersUpdated: robot.lastFullAt }; });
route('GET', /^\/api\/rooms$/, () => {
  const r = roomStore();
  return { ...r, rooms: r.rooms.map((x) => ({ ...x, id: rooms.roomKey(x), regionId: x.id, passes: rooms.roomPasses(x) })), currentVersion: rooms.currentVersion(robot.state.pmaps, r.pmapId), maps: robot.state.pmaps || [] };
});
route('PUT', /^\/api\/rooms\/([\w-]+)$/, (req, body, [id]) => {
  const r = roomStore();
  const room = rooms.findRoom(r, id);
  if (!room) throw Object.assign(new Error('unknown room'), { status: 404 });
  if ('name' in body) room.name = String(body.name || '').trim() || null;
  if ('passes' in body) {
    if (body.passes !== null && !rooms.PASSES[body.passes]) throw new Error('passes must be auto, one or two');
    room.passes = body.passes || undefined;
  }
  store.set('rooms', r);
  // A room is usually named while its first clean is still running; fix that mission's label too.
  const cur = tracker.current;
  if (cur && Array.isArray(cur.rooms) && cur.rooms.some((x) => x.id === id)) {
    cur.rooms = cur.rooms.map((x) => (x.id === id ? { ...x, name: rooms.roomName(r, id) } : x));
    store.saveMission(cur);
  }
  if ('name' in body) record('rooms', `Room #${id} named “${room.name || ''}”`);
  if ('passes' in body) record('rooms', `${rooms.roomName(r, id)}: ${rooms.roomPasses(room) || 'default'} pass${rooms.roomPasses(room) === 'one' ? '' : 'es'}`);
  pushStatus();
  return { ...r, rooms: r.rooms.map((x) => ({ ...x, id: rooms.roomKey(x), regionId: x.id, passes: rooms.roomPasses(x) })) };
});
route('DELETE', /^\/api\/rooms\/([\w-]+)$/, (req, body, [id]) => {
  const r = roomStore();
  r.rooms = r.rooms.filter((x) => rooms.roomKey(x) !== id);
  store.set('rooms', r);
  pushStatus();
  return r;
});
route('POST', /^\/api\/rooms\/clean$/, (req, body) => cleanRoomList(body.rooms || []));
// Wait to see whether the robot sets off, refuses with error 224, or does
// nothing. It briefly reports a clean cycle while still docked even when it is
// about to refuse, so only a "run" (or travelling home mid-mission) counts.
function cleanOutcome (timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = () => {
      const m = robot.state.cleanMissionStatus || {};
      return m.cycle && m.cycle !== 'none' && (m.phase === 'run' || String(m.phase).startsWith('hm'));
    };
    const finish = (result) => { clearTimeout(t); robot.off('update', check); resolve(result); };
    const check = () => { if (started()) finish('started'); };
    const t = setTimeout(() => finish(started() ? 'started' : (robot.state.cleanMissionStatus || {}).error === 224 ? 'rejected' : 'ignored'), timeoutMs);
    robot.on('update', check);
  });
}

// The robot accepts only some map versions: after a clean it saves a newer
// local version it rejects, but after a map edit in the iRobot app it wants
// the new one. Try the version learned from the app first; if the robot
// refuses (error 224) or ignores it, retry once with its latest and remember
// what worked.
async function cleanRoomList (ids, label, { passes } = {}) {
  const names = ids.map((id) => rooms.roomName(roomStore(), id)).join(' → ');
  const store0 = roomStore();
  const latest = rooms.currentVersion(robot.state.pmaps, store0.pmapId);
  const versions = [...new Set([store0.version, latest].filter(Boolean))];
  for (const [i, version] of versions.entries()) {
    const args = { ...rooms.buildCleanArgs(store0, robot.state.pmaps, ids, { ordered: true }), user_pmapv_id: version };
    if (passes) args.regions = args.regions.map((r) => ({ ...r, params: rooms.PASSES[passes] }));
    await robot.cleanRooms(args);
    const outcome = await cleanOutcome();
    // An out-of-date version is sometimes refused with 224 and sometimes
    // silently ignored, so either way try the robot's latest before giving up.
    if (outcome !== 'started' && i < versions.length - 1) {
      log.info(`room clean ${outcome} with map ${version}; retrying with ${versions[i + 1]}`);
      continue;
    }
    if (outcome === 'ignored') {
      const noMap = !(robot.state.pmaps || []).length;
      const why = noMap ? 'it currently reports no saved map (it may still be processing a map change)' : 'it ignored the request without an error';
      record('error', `The robot didn't start cleaning ${names}: ${why}. Try again in a few minutes, start it once from the iRobot app, or restart the robot.`, { rooms: ids });
      throw new Error(`the robot didn't start: ${why}`);
    }
    if (outcome === 'started') {
      if (version !== store0.version) {
        store.set('rooms', { ...roomStore(), version });
        record('rooms', `Map version updated to ${version}`);
        syncRobotSchedules(); // stored schedules carry the version too
      }
      record('command', `${label ? `${label}: ` : ''}cleaning ${names}`, { rooms: ids, version });
      return { ok: true, args, outcome };
    }
  }
  record('error', `The robot refused to clean ${names} (error 224, map out of date). Start one room clean from the iRobot app so Sweep can learn the current map; if the app is refused too, restart the robot.`, { rooms: ids });
  throw new Error('the robot refused (map out of date). Start one room clean from the iRobot app, or restart the robot if the app is refused too, then try again.');
}
route('GET', /^\/api\/routines$/, () => routines());
route('POST', /^\/api\/routines$/, (req, body) => {
  const r = rooms.validateRoutine(body, roomStore());
  const list = routines();
  const id = `r${Date.now().toString(36)}`;
  list.push({ id, ...r });
  store.set('routines', list);
  syncRobotSchedules();
  record('routine', `Saved routine “${r.name}”`);
  pushStatus();
  return { id };
});
route('PUT', /^\/api\/routines\/([\w-]+)$/, (req, body, [id]) => {
  const list = routines();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw Object.assign(new Error('unknown routine'), { status: 404 });
  list[i] = { id, ...rooms.validateRoutine(body, roomStore()) };
  store.set('routines', list);
  syncRobotSchedules();
  pushStatus();
  return list[i];
});
route('DELETE', /^\/api\/routines\/([\w-]+)$/, (req, body, [id]) => {
  store.set('routines', routines().filter((x) => x.id !== id));
  syncRobotSchedules();
  pushStatus();
  return { ok: true };
});
route('POST', /^\/api\/routines\/([\w-]+)\/clean$/, async (req, body, [id]) => {
  const r = routines().find((x) => x.id === id);
  if (!r) throw Object.assign(new Error('unknown routine'), { status: 404 });
  return cleanRoomList(r.rooms, r.name);
});
route('GET', /^\/api\/map$/, () => {
  const missions = store.missions({ limit: 40 }).filter((m) => m.end && m.cloud && m.cloud.version)
    .map(withRoomNames).map((m) => ({ id: m.id, start: m.start, rooms: m.rooms || [], result: m.result, verdict: m.review ? m.review.verdict : null, sqft: m.sqft || null }));
  return {
    cloud: cloud ? cloud.status() : { configured: false },
    map: mapData(),
    view: mapView(),
    rooms: roomStore().rooms.map((r) => ({ key: rooms.roomKey(r), type: r.type, name: r.name, passes: rooms.roomPasses(r) })),
    missions
  };
});
route('POST', /^\/api\/map\/refresh$/, async () => {
  if (!cloud) throw new Error('iRobot account not set up; run bin/sweep-cloud-login');
  const map = await refreshMap({ force: true });
  return { ok: true, version: map.version };
});
route('GET', /^\/api\/map\/coverage\/([\w-]+)$/, (req, body, [id]) => coverageFor(id));
route('PUT', /^\/api\/map\/view$/, (req, body) => {
  const v = { ...mapView() };
  if (body.rotate != null) v.rotate = ((Math.round(Number(body.rotate)) % 4) + 4) % 4;
  if (body.mirror != null) v.mirror = !!body.mirror;
  store.set('mapView', v);
  return v;
});

// Developer endpoints for research: the robot's full raw state, and a raw
// settings write (a "delta"). Changes still require the X-Sweep header.
route('GET', /^\/api\/raw$/, () => robot.state);
route('POST', /^\/api\/raw\/delta$/, async (req, body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) throw new Error('send an object of settings to change');
  await robot.setPreferences(body);
  record('settings', `Raw setting change: ${JSON.stringify(body)}`, body);
  return { ok: true };
});
route('GET', /^\/api\/insights$/, () => ({ warnings: currentWarnings(), review: reviewSettings() }));
route('PUT', /^\/api\/review$/, (req, body) => {
  const next = { ...reviewSettings(), autoRetry: !!body.autoRetry };
  store.set('review', next);
  record('review', next.autoRetry ? 'Poor room cleans will be retried once with two passes' : 'Automatic retries turned off');
  return next;
});
route('GET', /^\/api\/maintenance$/, () => maintenance.status(maintRecords(), robot.state));
route('POST', /^\/api\/maintenance\/(\w+)\/done$/, (req, body, [key]) => {
  store.set('maintenance', maintenance.markDone(maintRecords(), key, robot.state));
  record('maintenance', `Done: ${maintenance.ITEMS.find((i) => i.key === key).label}`);
  pushStatus();
  return maintenance.status(maintRecords(), robot.state);
});
route('PUT', /^\/api\/maintenance\/(\w+)$/, (req, body, [key]) => {
  store.set('maintenance', maintenance.setInterval(maintRecords(), key, body.interval));
  pushStatus();
  return maintenance.status(maintRecords(), robot.state);
});
route('GET', /^\/api\/missions$/, (req, body, m, q) => store.missions({ limit: Number(q.get('limit')) || 100, since: Number(q.get('since')) || 0 }).map(missionSummary));
route('GET', /^\/api\/missions\/([\w-]+)$/, (req, body, [id]) => {
  const m = store.mission(id);
  if (!m) throw Object.assign(new Error('not found'), { status: 404 });
  return { ...withRoomNames(m), samples: store.samples({ mission: id }) };
});
route('GET', /^\/api\/stats$/, (req, body, m, q) => {
  const days = Number(q.get('days')) || 90;
  const missions = store.missions({ limit: 5000, since: Date.now() - days * 86400000 }).filter((x) => x.end);
  const sum = (f) => missions.reduce((a, x) => a + (f(x) || 0), 0);
  return {
    days,
    count: missions.length,
    completed: missions.filter((x) => x.result === 'completed').length,
    minutes: sum((x) => x.missionMinutes),
    sqft: sum((x) => x.sqft),
    bumps: sum((x) => x.stats && x.stats.bumps),
    stuck: sum((x) => x.stats && x.stats.stuck),
    errors: sum((x) => x.errors && x.errors.length),
    missions: missions.map((x) => ({ id: x.id, start: x.start, end: x.end, minutes: x.missionMinutes, sqft: x.sqft, result: x.result, bumps: x.stats ? x.stats.bumps : null, batteryUsed: x.batteryStart != null && x.batteryMin != null ? x.batteryStart - x.batteryMin : null }))
  };
});
route('GET', /^\/api\/samples$/, (req, body, m, q) => store.samples({ since: Date.now() - (Number(q.get('hours')) || 24) * 3600000 }));
route('GET', /^\/api\/robot-schedules$/, () => {
  const written = store.get('robotSchedWritten', []);
  return {
    paused: !!robot.state.schedHold,
    hold: store.get('robotHold', null),
    entries: (robot.state.cleanSchedule2 || []).map((e) => ({ ...e, owner: written.some((w) => robotsched.same(w, e)) ? 'sweep' : 'app' }))
  };
});
route('POST', /^\/api\/robot-schedules\/sync$/, async () => { await syncRobotSchedules(); return { ok: true }; });
route('GET', /^\/api\/automations$/, () => ({ automations: store.automations(), next: nextScheduled(store.automations(), Date.now()) }));
route('POST', /^\/api\/automations$/, (req, body) => { validate(body); const id = store.saveAutomation({ ...body, id: undefined }); record('automation', `Added “${body.name}”`); syncRobotSchedules(); pushStatus(); return { id }; });
route('PUT', /^\/api\/automations\/(\d+)$/, (req, body, [id]) => { validate(body); store.saveAutomation({ ...body, id: Number(id) }); record('automation', `Updated “${body.name}”`); syncRobotSchedules(); pushStatus(); return { id: Number(id) }; });
route('DELETE', /^\/api\/automations\/(\d+)$/, (req, body, [id]) => { store.deleteAutomation(Number(id)); record('automation', `Deleted automation ${id}`); syncRobotSchedules(); pushStatus(); return { ok: true }; });
route('GET', /^\/api\/alerts$/, () => alerts.config());
route('PUT', /^\/api\/alerts$/, (req, body) => alerts.update(body));
route('GET', /^\/api\/quiet$/, () => quiet());
route('PUT', /^\/api\/quiet$/, (req, body) => { const q = { ...quiet(), ...body }; store.set('quiet', q); pushStatus(); return q; });
route('GET', /^\/api\/presence$/, () => presence.state());
route('PUT', /^\/api\/presence$/, async (req, body) => {
  const devices = (body.devices || []).filter((d) => d && /^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip)).map((d) => ({ name: String(d.name || d.ip), ip: d.ip }));
  store.set('presence', { devices, awayAfterMin: Number(body.awayAfterMin) || 15 });
  await presence.check();
  pushStatus();
  return presence.state();
});
route('GET', /^\/api\/log$/, (req, body, m, q) => store.events({ limit: Number(q.get('limit')) || 200, kind: q.get('kind') }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  // Changes require a custom header. Browsers can't send one cross-origin
  // without a CORS preflight we never approve, so web pages can't drive the robot.
  if (req.method !== 'GET' && req.headers['x-sweep'] !== '1') return json(res, 403, { error: 'missing X-Sweep header' });
  for (const r of routes) {
    const m = r.method === req.method && r.pattern.exec(url.pathname);
    if (!m) continue;
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
      return json(res, 200, await r.fn(req, body, m.slice(1), url.searchParams));
    } catch (e) {
      return json(res, e.status || (/not connected/.test(e.message) ? 503 : 400), { error: e.message });
    }
  }
  json(res, 404, { error: 'not found' });
});

// ---------- timers ----------
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);
setInterval(() => { if (!tracker.current) sample(true); }, 60000);
setInterval(() => store.pruneSamples(Date.now() - 30 * 86400000), 6 * 3600000);
setInterval(() => tick().catch((e) => log.error(e)), 30000);
setInterval(() => presence.check().then(pushStatus).catch((e) => log.error(e)), 60000);
setInterval(() => {
  if (offlineSince && Date.now() - offlineSince > 10 * 60000) {
    alerts.send('offline', 'Robot offline', 'Sweep has not been able to reach the robot for 10 minutes.', { cooldownMs: 6 * 3600000 });
  }
}, 60000);
// Counters only refresh on reconnect; keep them reasonably fresh while docked.
setInterval(() => {
  const m = robot.state.cleanMissionStatus || {};
  if (robot.connected && !tracker.current && m.phase === 'charge') robot.refresh().then(pushStatus).catch((e) => log.error(e));
}, 6 * 3600000);

setInterval(checkWarnings, 6 * 3600000);
try { backfillReviews(); } catch (e) { log.error('review backfill failed:', e.message); }

server.listen(PORT, '127.0.0.1', () => {
  log.info(`sweepd ${VERSION} listening on http://127.0.0.1:${PORT}`);
  if (cfg) robot.connect();
  // Load the map shortly after start, then twice a day.
  mapRefreshSoon(10000);
  if (cloud) setInterval(() => refreshMap().catch((e) => log.error('map refresh failed:', e.message)), 12 * 3600000);
  presence.check().catch((e) => log.error(e));
});

function shutdown () { robot.close(); server.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
