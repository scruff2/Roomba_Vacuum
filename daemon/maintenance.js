'use strict';
// Maintenance reminders driven by real use. The robot's lifetime counters
// tell us cleaning time and how often the dock emptied the bin; each item
// remembers the counter value when it was last done, and is due once the
// counter has moved on by its interval.

// Intervals are starting points from typical iRobot care guidance; each can be changed.
const ITEMS = [
  { key: 'cleanFilter', label: 'Clean the filter', meter: 'hours', interval: 15, tip: 'Tap the filter over the bin to knock the dust out.' },
  { key: 'cleanBrushes', label: 'Clean the rubber brushes', meter: 'hours', interval: 15, tip: 'Pull out both brushes and remove hair from the ends and bearings.' },
  { key: 'cleanEdgeBrush', label: 'Clean the edge-sweeping brush', meter: 'hours', interval: 30, tip: 'Unscrew it and remove hair wrapped around the post.' },
  { key: 'cleanSensors', label: 'Wipe sensors and charging contacts', meter: 'hours', interval: 30, tip: 'Use a dry cloth on the cliff sensors, camera window and contacts on robot and dock.' },
  { key: 'replaceFilter', label: 'Replace the filter', meter: 'hours', interval: 60, tip: 'Filters clog over time even when cleaned.' },
  { key: 'replaceEdgeBrush', label: 'Replace the edge-sweeping brush', meter: 'hours', interval: 120, tip: 'Replace when the bristles are bent or frayed.' },
  { key: 'replaceBrushes', label: 'Replace the rubber brushes', meter: 'hours', interval: 180, tip: 'Replace when the rubber treads look worn.' },
  { key: 'replaceBag', label: 'Replace the dock bag', meter: 'evacs', interval: 30, tip: 'The dock bag fills after roughly 30 bin emptyings.' }
];

// Current meter readings from the robot's state.
function meters (state) {
  const rt = state.runtimeStats;
  const hours = rt && (rt.hr != null || rt.min != null) ? (rt.hr || 0) + (rt.min || 0) / 60 : null;
  const evacs = state.bbrun && state.bbrun.nEvacs != null ? state.bbrun.nEvacs : null;
  return { hours, evacs };
}

// records: { [key]: { baseline, doneAt, interval?, notifiedAt? } }
// Items never recorded start counting from now (treated as just done).
function ensureBaselines (records, state, now = Date.now()) {
  const m = meters(state);
  const out = { ...(records || {}) };
  let changed = false;
  for (const item of ITEMS) {
    if (!out[item.key] && m[item.meter] != null) {
      out[item.key] = { baseline: m[item.meter], doneAt: now, tracked: now };
      changed = true;
    }
  }
  return { records: out, changed };
}

function status (records, state) {
  const m = meters(state);
  return ITEMS.map((item) => {
    const rec = (records || {})[item.key] || null;
    const interval = rec && rec.interval ? rec.interval : item.interval;
    const used = rec && m[item.meter] != null ? Math.max(0, m[item.meter] - rec.baseline) : null;
    return {
      key: item.key,
      label: item.label,
      tip: item.tip,
      meter: item.meter,
      interval,
      defaultInterval: item.interval,
      used,
      remaining: used == null ? null : interval - used,
      fraction: used == null ? null : Math.min(1, used / interval),
      due: used != null && used >= interval,
      doneAt: rec ? rec.doneAt : null,
      notifiedAt: rec ? rec.notifiedAt || null : null
    };
  });
}

function markDone (records, key, state, now = Date.now()) {
  const item = ITEMS.find((i) => i.key === key);
  if (!item) throw new Error(`unknown maintenance item: ${key}`);
  const value = meters(state)[item.meter];
  if (value == null) throw new Error('the robot has not reported its counters yet');
  const prev = (records || {})[key] || {};
  return { ...(records || {}), [key]: { ...prev, baseline: value, doneAt: now, notifiedAt: null } };
}

function setInterval_ (records, key, interval) {
  const item = ITEMS.find((i) => i.key === key);
  if (!item) throw new Error(`unknown maintenance item: ${key}`);
  const n = Number(interval);
  if (!(n > 0 && n <= 10000)) throw new Error('interval must be a positive number');
  const prev = (records || {})[key] || {};
  return { ...(records || {}), [key]: { ...prev, interval: n } };
}

// Items that just became due and haven't been announced yet.
function newlyDue (records, state) {
  return status(records, state).filter((s) => s.due && !s.notifiedAt);
}

module.exports = { ITEMS, meters, ensureBaselines, status, markDone, setInterval: setInterval_, newlyDue };
