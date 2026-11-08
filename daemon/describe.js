'use strict';
// Plain-English labels and derived views of the robot's raw state.

const PHASES = {
  charge: 'Docked', run: 'Cleaning', stop: 'Stopped', pause: 'Paused',
  hmUsrDock: 'Returning to dock', hmMidMsn: 'Docking to recharge', hmPostMsn: 'Finished, docking',
  stuck: 'Stuck', evac: 'Emptying bin', chargingerror: 'Charging error', '': 'Idle'
};

const ERRORS = {
  1: 'Left wheel off floor', 2: 'Main brushes stuck', 3: 'Right wheel off floor', 4: 'Left wheel stuck',
  5: 'Left wheel stuck', 6: 'Cliff sensors blocked', 7: 'Left wheel error', 8: 'Bin error',
  9: 'Bumper stuck', 10: 'Right wheel stuck', 11: 'Right wheel error', 12: 'Cliff detected',
  14: 'Bin missing', 15: 'Reboot required', 16: 'Bumped unexpectedly', 17: 'Path blocked',
  18: 'Docking issue', 19: 'Undocking issue', 20: 'Docking issue', 21: 'Navigation problem',
  22: 'Navigation problem', 23: 'Battery issue', 24: 'Navigation problem', 25: 'Reboot required',
  26: 'Vacuum problem', 27: 'Vacuum problem', 29: 'Software update needed', 30: 'Vacuum problem',
  31: 'Reboot required', 32: 'Smart map problem', 33: 'Path blocked', 34: 'Reboot required',
  35: 'Unrecognised cleaning pad', 36: 'Bin full', 37: 'Tank needs refilling', 38: 'Vacuum problem',
  39: 'Reboot required', 40: 'Navigation problem', 41: 'Timed out', 42: 'Localization problem',
  43: 'Navigation problem', 44: 'Pump issue', 45: 'Lid open', 46: 'Low battery', 47: 'Reboot required',
  48: 'Path blocked', 52: 'Pad required attention', 53: 'Software update required', 54: 'Blades stuck',
  55: 'Left blades stuck', 56: 'Right blades stuck', 57: 'Cutting deck stuck', 58: 'Navigation problem',
  59: 'Pad not detected', 60: 'Tank empty', 62: 'Stuck on edge', 63: 'Stuck under object',
  65: 'Hardware problem detected', 66: 'Low memory', 68: 'Camera or sensor problem', 73: 'Pad type changed',
  74: 'Max area reached', 75: 'Navigation problem', 76: 'Hardware problem detected', 88: 'Back-up refused',
  89: 'Mission runtime too long', 101: 'Battery not connected', 102: 'Charging error',
  103: 'Charging error', 104: 'No charge current', 105: 'Charging current too low',
  106: 'Battery too warm', 107: 'Battery temperature incorrect', 108: 'Battery communication failure',
  109: 'Battery error', 110: 'Battery cell imbalance', 111: 'Battery communication failure',
  112: 'Invalid charging load', 114: 'Internal battery failure', 115: 'Cell failure during charging',
  116: 'Charging error', 118: 'Battery communication failure', 119: 'Charging timeout',
  120: 'Battery not initialized', 122: 'Charging system error', 123: 'Battery not initialized',
  216: 'Charging base bag full',
  // Seen when a room clean names a map version the robot won't accept (e.g. after the map was edited).
  224: 'Map out of date for this room clean'
};

function errorText (code) { return code ? (ERRORS[code] || `Error ${code}`) : null; }

function status (robot, extra = {}) {
  const s = robot.state;
  const m = s.cleanMissionStatus || {};
  return {
    connected: robot.connected,
    name: s.name || null,
    sku: s.sku || null,
    phase: m.phase ?? null,
    phaseLabel: m.phase == null ? null : (PHASES[m.phase] ?? m.phase),
    cycle: m.cycle ?? null,
    active: !!(m.cycle && m.cycle !== 'none'),
    error: m.error || 0,
    errorText: errorText(m.error),
    notReady: m.notReady || 0,
    missionMinutes: m.mssnM ?? null,
    sqft: m.sqft ?? null,
    missionId: m.missionId || null,
    initiator: m.initiator || null,
    battery: s.batPct ?? null,
    bin: s.bin || null,
    rssi: s.signal ? s.signal.rssi : null,
    lastCommand: s.lastCommand || null,
    ...extra
  };
}

function parseBatteryDate (d) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(d || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function health (robot) {
  const s = robot.state;
  const b = s.batInfo || {};
  const made = parseBatteryDate(b.mDate);
  return {
    battery: {
      percent: s.batPct ?? null,
      cycles: b.cCount ?? null,
      manufacturer: b.mName || null,
      manufactured: b.mDate || null,
      ageDays: made ? Math.floor((Date.now() - made) / 86400000) : null,
      type: s.batteryType || null
    },
    charging: s.bbchg || null,
    resets: s.bbrstinfo || null,
    lifetime: {
      missions: s.bbmssn || null,
      run: s.bbrun || null,
      switches: s.bbswitch || null,
      cleaning: s.runtimeStats || null,
      poweredOn: s.bbsys || null
    },
    navigation: s.mssnNavStats || null,
    wifi: { signal: s.signal || null, net: s.netinfo ? { addr: s.netinfo.addr, gw: s.netinfo.gw, freq: s.netinfo.freq } : null },
    firmware: { software: s.softwareVer || null, modules: s.subModSwVer || null, secureBoot: s.secureBoot ? s.secureBoot.recov : null },
    dock: s.dock || null,
    hardware: s.hwPartsRev ? { navBoard: s.hwPartsRev.NavBrd, mobilityBoard: s.hwPartsRev.mobBrd, imu: s.hwPartsRev.imuPartNo } : null,
    countersUpdated: robot.lastFullAt || null
  };
}

module.exports = { PHASES, ERRORS, errorText, status, health };
