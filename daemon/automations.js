'use strict';
// Rule evaluation for automations. Pure: given rules and a context it
// returns which rules fire and which were skipped (and why), so it is easy
// to test and the daemon decides what to actually do.
//
// Rule types:
//   schedule  {days: [0-6, 0 = Sunday], time: 'HH:MM', minBattery, skipIfCleanedWithinH, onlyWhenAway}
//   away      {delayMin, minBattery, skipIfCleanedWithinH}  start once everyone has been gone delayMin
//   arrive    {action: 'dock' | 'pause'}                    stop cleaning when someone comes home

const WINDOW_MIN = 10; // how late a schedule may still fire, e.g. after a daemon restart

function parseHM (s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

function minuteOfDay (d) { return d.getHours() * 60 + d.getMinutes(); }

function inQuietHours (now, quiet) {
  if (!quiet || !quiet.enabled) return false;
  const a = parseHM(quiet.start); const b = parseHM(quiet.end);
  if (a == null || b == null || a === b) return false;
  const m = minuteOfDay(new Date(now));
  return a < b ? m >= a && m < b : m >= a || m < b; // window may wrap midnight
}

function targetToday (now, time) {
  const t = parseHM(time);
  if (t == null) return null;
  const d = new Date(now);
  d.setHours(Math.floor(t / 60), t % 60, 0, 0);
  return d.getTime();
}

// Conditions shared by every rule that starts a clean.
function startBlocker (cfg, ctx) {
  if (!ctx.connected) return 'robot offline';
  if (ctx.active) return 'already cleaning';
  if (inQuietHours(ctx.now, ctx.quiet)) return 'quiet hours';
  if (cfg.minBattery && ctx.battery != null && ctx.battery < cfg.minBattery) return `battery ${ctx.battery}% below ${cfg.minBattery}%`;
  if (cfg.skipIfCleanedWithinH && ctx.lastCleanEnd && ctx.now - ctx.lastCleanEnd < cfg.skipIfCleanedWithinH * 3600000) {
    return `cleaned within the last ${cfg.skipIfCleanedWithinH} h`;
  }
  if (cfg.onlyWhenAway && ctx.presence && ctx.presence.configured && ctx.presence.home) return 'someone is home';
  return null;
}

function evaluate (rules, ctx) {
  const fired = []; const skipped = [];
  const outcome = (rule, action, reason) => {
    const blocker = action === 'start' ? startBlocker(rule.config || {}, ctx) : (!ctx.connected ? 'robot offline' : null);
    if (blocker) skipped.push({ rule, reason: blocker, trigger: reason });
    else fired.push({ rule, action, reason });
  };

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const cfg = rule.config || {};
    const p = ctx.presence || {};

    if (rule.type === 'schedule') {
      // Schedules stored on the robot start by themselves; see robotHolds.
      if (cfg.onRobot) continue;
      const day = new Date(ctx.now).getDay();
      const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days : [0, 1, 2, 3, 4, 5, 6];
      const target = targetToday(ctx.now, cfg.time);
      if (target == null || !days.includes(day)) continue;
      if (ctx.now >= target && ctx.now < target + WINDOW_MIN * 60000 && !(rule.lastRun >= target)) {
        outcome(rule, 'start', `scheduled ${cfg.time}`);
      }
    } else if (rule.type === 'away') {
      if (!p.configured || p.home || !p.since) continue;
      const due = p.since + (cfg.delayMin || 0) * 60000;
      if (ctx.now >= due && !(rule.lastRun >= p.since)) outcome(rule, 'start', 'everyone left');
    } else if (rule.type === 'arrive') {
      if (!p.configured || !p.home || !p.since || !ctx.active) continue;
      if (ctx.now - p.since < 15 * 60000 && !(rule.lastRun >= p.since)) {
        outcome(rule, cfg.action === 'pause' ? 'pause' : 'dock', 'someone came home');
      }
    }
  }
  return { fired, skipped };
}

// On-robot schedules start by themselves, even with this laptop off. While
// Sweep is running it can still apply their conditions: for each run due in
// the next few minutes whose conditions say "skip", return a hold so the
// daemon pauses the robot's schedules (schedHold) until just after it.
const HOLD_LEAD_MIN = 3;
const HOLD_AFTER_MIN = 5;
function robotHolds (rules, ctx) {
  const holds = [];
  for (const rule of rules) {
    const cfg = rule.config || {};
    if (!rule.enabled || rule.type !== 'schedule' || !cfg.onRobot) continue;
    const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days : [0, 1, 2, 3, 4, 5, 6];
    const target = targetToday(ctx.now, cfg.time);
    if (target == null || !days.includes(new Date(ctx.now).getDay())) continue;
    if (ctx.now < target - HOLD_LEAD_MIN * 60000 || ctx.now >= target) continue;
    // "Offline" and "already cleaning" need no hold: the robot can't be
    // reached, or won't start a second clean anyway.
    const blocker = startBlocker(cfg, { ...ctx, connected: true, active: false });
    if (blocker) holds.push({ rule, reason: blocker, target, until: target + HOLD_AFTER_MIN * 60000 });
  }
  return holds;
}

// Next time any enabled schedule rule will fire, for display.
function nextScheduled (rules, now) {
  let best = null;
  for (const rule of rules) {
    if (!rule.enabled || rule.type !== 'schedule') continue;
    const cfg = rule.config || {};
    const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days : [0, 1, 2, 3, 4, 5, 6];
    for (let i = 0; i < 8; i++) {
      const t = targetToday(now + i * 86400000, cfg.time);
      if (t == null) break;
      if (t > now && days.includes(new Date(t).getDay())) {
        if (!best || t < best.t) best = { t, ruleId: rule.id, name: rule.name };
        break;
      }
    }
  }
  return best;
}

function validate (a) {
  if (!a || typeof a.name !== 'string' || !a.name.trim()) throw new Error('name is required');
  if (!['schedule', 'away', 'arrive'].includes(a.type)) throw new Error('type must be schedule, away or arrive');
  const c = a.config || {};
  if (a.type === 'schedule' && parseHM(c.time) == null) throw new Error('schedule needs time as HH:MM');
  if (c.days && (!Array.isArray(c.days) || c.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error('days must be 0-6');
  if (c.routineId != null && typeof c.routineId !== 'string') throw new Error('routineId must be a string');
  if (c.onRobot && a.type !== 'schedule') throw new Error('only time-based schedules can run on the robot');
  if (c.rooms && (!Array.isArray(c.rooms) || c.rooms.some((r) => typeof r !== 'string'))) throw new Error('rooms must be a list of room ids');
  return true;
}

module.exports = { evaluate, robotHolds, nextScheduled, inQuietHours, parseHM, validate };
