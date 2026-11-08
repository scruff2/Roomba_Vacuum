'use strict';
// The "smarter brain" on top of the robot: judge each finished mission, and
// watch the counters over time for early signs of wear. Pure functions; the
// daemon decides what to do with the results.

// Minutes the robot spent out cleaning (the run phases, which include travel).
function runMinutes (m) {
  const phases = m.phases || [];
  let ms = 0;
  for (let i = 0; i < phases.length; i++) {
    if (phases[i][1] !== 'run') continue;
    const end = i + 1 < phases.length ? phases[i + 1][0] : (m.end || phases[i][0]);
    ms += Math.max(0, end - phases[i][0]);
  }
  return ms / 60000;
}

function roomKeyOf (m) { return (m.rooms || []).map((r) => r.id).join(','); }

// Typical run time for the same rooms, from earlier missions judged good.
function typicalRun (history, m) {
  const key = roomKeyOf(m);
  if (!key) return null;
  const runs = history
    .filter((h) => h.id !== m.id && roomKeyOf(h) === key && h.review && h.review.verdict === 'good')
    .map(runMinutes)
    .sort((a, b) => a - b);
  return runs.length >= 2 ? runs[Math.floor(runs.length / 2)] : null;
}

// Judge a finished mission. Returns {verdict: 'good'|'poor'|'error'|'stopped', reasons, advice, metrics}.
function reviewMission (m, history = [], { evacAllowed = true } = {}) {
  const run = runMinutes(m);
  const st = m.stats || {};
  const bumpsPerMin = run > 0 && st.bumps != null ? st.bumps / run : null;
  const metrics = { runMinutes: Math.round(run * 10) / 10, bumpsPerMin: bumpsPerMin == null ? null : Math.round(bumpsPerMin), escapes: st.panics || 0, stuck: st.stuck || 0, binEmptied: (st.evacs || 0) > 0 };
  const reasons = []; const advice = [];

  if (m.result === 'error' || (m.errors && m.errors.length)) {
    return { verdict: 'error', reasons: ['The robot reported an error during the mission.'], advice: ['Check the error on the Home page; it usually names the part to clear.'], metrics };
  }
  if (m.result === 'stopped' || m.result === 'superseded') {
    return { verdict: 'stopped', reasons: ['The mission was stopped before the robot finished.'], advice: [], metrics };
  }

  const typical = typicalRun(history, m);
  if (typical != null && run < typical * 0.5) {
    reasons.push(`It ran ${metrics.runMinutes} min, under half its usual ${Math.round(typical * 10) / 10} min for these rooms.`);
  } else if (m.rooms && m.rooms.length && run < 2) {
    reasons.push(`It was only out for ${metrics.runMinutes} min, including driving there and back.`);
  }
  if (bumpsPerMin != null && bumpsPerMin > 40 && st.bumps >= 30) {
    reasons.push(`It bumped into things ${metrics.bumpsPerMin} times a minute (${st.bumps} in total), which usually means a cramped or cluttered spot.`);
    advice.push('Clear space around the area, move mats aside, or leave a gap of at least 35 cm next to furniture and boxes.');
  }
  if (metrics.escapes >= 3 || metrics.stuck > 0) {
    reasons.push(metrics.stuck ? `It got stuck ${metrics.stuck} time(s).` : `It needed ${metrics.escapes} escape manoeuvres.`);
    advice.push('Look for cords, rugs with tassels or low furniture in that room.');
  }
  // The dock empties the bin after a normal clean; skipping it suggests little was picked up.
  if (evacAllowed && !metrics.binEmptied && reasons.length) {
    reasons.push('The dock didn\'t empty the bin afterwards, as it does after a normal clean.');
  }
  if (reasons.length) {
    if (m.rooms && m.rooms.length) advice.push('Check the iRobot app\'s history for this clean: it shows what was covered and any obstacles it avoided.');
    return { verdict: 'poor', reasons, advice, metrics };
  }
  return { verdict: 'good', reasons: [], advice: [], metrics };
}

// --- Early warnings ---------------------------------------------------------

function lifetimeHours (state) {
  const rt = state.runtimeStats || {};
  return (rt.hr || 0) + (rt.min || 0) / 60;
}

// Recent rate of a per-mission counter (per cleaning hour) vs the robot's lifetime rate.
function rateCheck ({ missions, state, stat, lifetime, minHours = 2 }) {
  const recent = missions.filter((m) => m.stats && m.stats.cleanMinutes);
  const hours = recent.reduce((a, m) => a + m.stats.cleanMinutes, 0) / 60;
  const count = recent.reduce((a, m) => a + (m.stats[stat] || 0), 0);
  const lifeHours = lifetimeHours(state);
  if (hours < minHours || !lifeHours || lifetime == null) return null;
  return { recent: count / hours, lifetime: lifetime / lifeHours, count, hours };
}

// missions: finished missions from the last few weeks, newest first.
// snapshots: [{t, counters}] counter snapshots over time (from mission starts/ends).
function healthWarnings ({ state, missions = [], snapshots = [], samples = [], now = Date.now() }) {
  const out = [];
  const add = (key, level, title, detail, advice) => out.push({ key, level, title, detail, advice });
  const run = state.bbrun || {};
  const fmt = (n) => (Math.round(n * 10) / 10).toString();

  const stalls = rateCheck({ missions, state, stat: 'brushStalls', lifetime: run.nMBStll });
  if (stalls && stalls.count >= 3 && stalls.recent > stalls.lifetime * 2) {
    add('brushStalls', 'warn', 'Brushes are stalling more than usual',
      `${stalls.count} brush stalls in the last ${fmt(stalls.hours)} cleaning hours (${fmt(stalls.recent)}/h, vs ${fmt(stalls.lifetime)}/h over the robot's life).`,
      'Pull out both rubber brushes and clear hair from the ends and axle holes.');
  }
  const panics = rateCheck({ missions, state, stat: 'panics', lifetime: run.nPanics });
  if (panics && panics.count >= 5 && panics.recent > panics.lifetime * 2) {
    add('escapes', 'warn', 'More escape manoeuvres than usual',
      `${panics.count} in the last ${fmt(panics.hours)} cleaning hours (${fmt(panics.recent)}/h, vs ${fmt(panics.lifetime)}/h over its life).`,
      'Something new may be in the way: cords, a rug edge, or furniture it gets under.');
  }
  const stuck = missions.reduce((a, m) => a + ((m.stats && m.stats.stuck) || 0), 0);
  if (stuck >= 2) {
    add('stuck', 'warn', 'Getting stuck repeatedly', `Stuck ${stuck} times in recent missions.`, 'Check the History page for which rooms; something there traps it.');
  }

  // Counter changes over the snapshot window (charging and restarts happen between missions too).
  if (snapshots.length >= 2) {
    const first = snapshots[snapshots.length - 1]; const last = snapshots[0];
    const delta = (k) => (last.counters[k] != null && first.counters[k] != null ? last.counters[k] - first.counters[k] : 0);
    const days = Math.max(1, (last.t - first.t) / 86400000);
    const inDays = Math.round(days) === 1 ? 'in the last day' : `in ${Math.round(days)} days`;
    if (delta('chargeChatters') >= 10) {
      add('contacts', 'warn', 'Charging contacts are flickering', `${delta('chargeChatters')} charging interruptions ${inDays}.`,
        'Wipe the metal contacts on the robot and the dock with a dry cloth.');
    }
    if (delta('chargeErrors') > 0) {
      add('chargeErrors', 'warn', 'Charging errors', `${delta('chargeErrors')} charging error(s) ${inDays}.`, 'Check the dock is plugged in firmly and the contacts are clean.');
    }
    const resets = delta('navResets') + delta('mobilityResets') + delta('memoryResets');
    if (resets >= 3) {
      add('resets', 'info', 'The robot restarted itself several times', `${resets} internal restarts ${inDays}.`, 'Usually harmless; if it keeps happening, restart the robot or check for a firmware update in the iRobot app.');
    }
  }

  // Battery: age, and missions that needed a recharge partway through.
  const made = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((state.batInfo || {}).mDate || '');
  if (made) {
    const years = (now - new Date(+made[1], +made[2] - 1, +made[3])) / (365.25 * 86400000);
    const recharges = missions.filter((m) => (m.phases || []).some((p) => p[1] === 'hmMidMsn')).length;
    if (years >= 3.5 && recharges >= 2) {
      add('battery', 'warn', 'The battery may be wearing out', `It's ${fmt(years)} years old and ${recharges} recent missions had to go back to recharge.`, 'A replacement battery would let it finish without stopping.');
    } else if (years >= 4) {
      add('batteryAge', 'info', 'Ageing battery', `The battery is ${fmt(years)} years old.`, 'Fine for now; if cleans start stopping to recharge, consider a replacement.');
    }
  }

  // Weak Wi-Fi during missions makes commands and status unreliable.
  const rssi = samples.filter((s) => s.rssi != null).map((s) => s.rssi);
  if (rssi.length >= 20) {
    const avg = rssi.reduce((a, b) => a + b, 0) / rssi.length;
    if (avg < -72) add('wifi', 'info', 'Weak Wi-Fi signal', `Average ${Math.round(avg)} dBm over the last day.`, 'Move the dock closer to the router or add an access point.');
  }

  return out;
}

module.exports = { runMinutes, reviewMission, healthWarnings, typicalRun };
