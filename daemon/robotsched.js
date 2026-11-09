'use strict';
// Robot-side schedules ("cleanSchedule2"): schedules stored on the robot run
// even when this laptop is off. Pure logic for turning Sweep's scheduled
// automations into robot entries and merging them with entries made in the
// iRobot app. The robot strips unknown fields, so Sweep can't tag its
// entries; it remembers exactly what it wrote and treats everything else as
// the app's.

const rooms = require('./rooms');

const MAX_ENTRIES = 21;

// Stable JSON (sorted keys) so entries compare equal however keys are ordered.
function canon (v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const same = (a, b) => canon(a) === canon(b);

function parseHM (s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m ? { hour: Number(m[1]), min: Number(m[2]) } : null;
}

// The rooms a rule cleans: its routine's rooms, its own room list, or none (whole house).
function ruleRooms (rule, routines) {
  const c = rule.config || {};
  if (c.routineId) {
    const r = (routines || []).find((x) => x.id === c.routineId);
    if (!r) throw new Error(`routine for “${rule.name}” no longer exists`);
    return r.rooms;
  }
  return Array.isArray(c.rooms) ? c.rooms : [];
}

// One robot entry for one enabled, on-robot schedule rule.
function toEntry (rule, roomStore, routines) {
  const c = rule.config || {};
  const t = parseHM(c.time);
  if (!t) throw new Error(`“${rule.name}” has no valid time`);
  const days = Array.isArray(c.days) && c.days.length ? [...c.days].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6];
  const ids = ruleRooms(rule, routines);
  let cmd = { command: 'start', ordered: 1 };
  if (ids.length) {
    const args = rooms.buildCleanArgs(roomStore, [], ids, { ordered: true });
    cmd = { command: 'start', ordered: 1, pmap_id: args.pmap_id, user_pmapv_id: args.user_pmapv_id, regions: args.regions };
  }
  return { enabled: true, type: 0, start: { day: days, hour: t.hour, min: t.min }, cmd };
}

// Entries Sweep wants on the robot, one per enabled on-robot schedule rule.
function desiredEntries (rules, roomStore, routines) {
  const entries = []; const errors = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.type !== 'schedule' || !(rule.config && rule.config.onRobot)) continue;
    try { entries.push({ ruleId: rule.id, entry: toEntry(rule, roomStore, routines) }); } catch (e) { errors.push({ ruleId: rule.id, error: e.message }); }
  }
  return { entries, errors };
}

// New robot list: the app's entries (anything Sweep didn't write) plus Sweep's.
function merge (robotList, previouslyWritten, desired) {
  const foreign = (robotList || []).filter((e) => !(previouslyWritten || []).some((w) => same(w, e)));
  const list = [...foreign, ...desired];
  if (list.length > MAX_ENTRIES) throw new Error(`the robot holds at most ${MAX_ENTRIES} schedules (would be ${list.length})`);
  return { list, foreign };
}

module.exports = { canon, same, toEntry, desiredEntries, merge, ruleRooms, MAX_ENTRIES };
