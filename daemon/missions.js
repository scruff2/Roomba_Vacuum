'use strict';
// Turns the robot's stream of status updates into mission records. Pure
// logic: the daemon feeds it state, it returns what happened.

// Lifetime counters that only refresh on reconnect. A mission's share of
// each is the difference between snapshots taken before and after it.
const COUNTERS = {
  bumps: 'bbswitch.nBumper',
  wheelDrops: 'bbswitch.nDrops',
  stuck: 'bbrun.nStuck',
  cliffs: 'bbrun.nCliffsF',
  panics: 'bbrun.nPanics',
  pickups: 'bbrun.nPicks',
  brushStalls: 'bbrun.nMBStll',
  wheelStalls: 'bbrun.nWStll',
  evacs: 'bbrun.nEvacs',
  overtemps: 'bbrun.nOvertemps',
  cleanMinutesTotal: 'runtimeStats.min',
  cleanHoursTotal: 'runtimeStats.hr',
  missionsTotal: 'bbmssn.nMssn',
  navResets: 'bbrstinfo.nNavRst',
  mobilityResets: 'bbrstinfo.nMobRst',
  memoryResets: 'bbrstinfo.nOomRst',
  chargeCycles: 'batInfo.cCount',
  chargeChatters: 'bbchg.nChatters',
  chargeErrors: 'bbchg.nChgErr'
};

function get (obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function snapshotCounters (state) {
  const out = {};
  for (const [name, p] of Object.entries(COUNTERS)) {
    const v = get(state, p);
    if (typeof v === 'number') out[name] = v;
  }
  return out;
}

function diffCounters (a, b) {
  const out = {};
  if (!a || !b) return out;
  for (const k of Object.keys(b)) if (typeof a[k] === 'number') out[k] = b[k] - a[k];
  // Runtime is stored as hours + minutes; fold into one number.
  if ('cleanMinutesTotal' in out || 'cleanHoursTotal' in out) {
    out.cleanMinutes = (out.cleanHoursTotal || 0) * 60 + (out.cleanMinutesTotal || 0);
    delete out.cleanMinutesTotal; delete out.cleanHoursTotal;
  }
  return out;
}

function isActive (m) { return !!(m && m.cycle && m.cycle !== 'none'); }

class MissionTracker {
  constructor (open = null) {
    this.current = open; // resumed from storage after a daemon restart
  }

  // Returns a list of events: {type: 'start'|'phase'|'error'|'end', mission, ...}
  feed (state, now = Date.now()) {
    const m = state.cleanMissionStatus;
    if (!m) return [];
    const events = [];
    let cur = this.current;

    // When a clean starts, the robot first reports the new cycle while still
    // docked and carrying the previous mission's id; the real id arrives a
    // moment later. Only open a mission once it has left the charge phase.
    if (isActive(m) && m.phase !== 'charge' && (!cur || (m.missionId && cur.id !== m.missionId))) {
      if (cur) events.push(...this._end(state, now, 'superseded'));
      cur = this.current = {
        id: m.missionId || `local-${now}`,
        start: (m.mssnStrtTm ? m.mssnStrtTm * 1000 : now),
        end: null,
        cycle: m.cycle,
        initiator: m.initiator || null,
        batteryStart: state.batPct ?? null,
        batteryEnd: null,
        batteryMin: state.batPct ?? null,
        missionMinutes: 0,
        sqft: null,
        phases: [],
        errors: [],
        countersStart: snapshotCounters(state),
        countersEnd: null,
        stats: {},
        result: null,
        sawFinish: false
      };
      events.push({ type: 'start', mission: cur });
    }
    if (!cur) return events;

    if (isActive(m)) {
      const last = cur.phases[cur.phases.length - 1];
      if (!last || last[1] !== m.phase) {
        cur.phases.push([now, m.phase]);
        events.push({ type: 'phase', mission: cur, phase: m.phase });
      }
      if (m.phase === 'hmPostMsn') cur.sawFinish = true;
      if (m.mssnM != null) cur.missionMinutes = Math.max(cur.missionMinutes, m.mssnM);
      if (m.sqft != null) cur.sqft = Math.max(cur.sqft || 0, m.sqft);
      if (state.batPct != null) cur.batteryMin = Math.min(cur.batteryMin ?? 100, state.batPct);
      if (m.error && !cur.errors.some((e) => e[1] === m.error && now - e[0] < 60000)) {
        cur.errors.push([now, m.error]);
        events.push({ type: 'error', mission: cur, code: m.error });
      }
    } else {
      events.push(...this._end(state, now));
    }
    return events;
  }

  _end (state, now, reason) {
    const cur = this.current;
    if (!cur) return [];
    this.current = null;
    cur.end = now;
    cur.batteryEnd = state.batPct ?? null;
    cur.result = reason || (cur.errors.length && !cur.sawFinish ? 'error' : cur.sawFinish ? 'completed' : 'stopped');
    return [{ type: 'end', mission: cur }];
  }
}

// Called once fresh counters are available after a mission ends.
function finalizeCounters (mission, state) {
  mission.countersEnd = snapshotCounters(state);
  mission.stats = diffCounters(mission.countersStart, mission.countersEnd);
  return mission;
}

module.exports = { COUNTERS, snapshotCounters, diffCounters, MissionTracker, finalizeCounters };
