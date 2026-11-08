'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, nextScheduled, inQuietHours, validate } = require('../automations');
const { buildDelta, readSettings } = require('../settings');

const at = (h, m, day = 0) => {
  // 2026-11-08 is a Sunday; add `day` days.
  const d = new Date(2026, 10, 8 + day, h, m, 0, 0);
  return d.getTime();
};
const ctx = (over = {}) => ({ now: at(9, 0), connected: true, active: false, battery: 90, lastCleanEnd: null, presence: { configured: false }, quiet: { enabled: false }, ...over });
const sched = (config, over = {}) => ({ id: 1, name: 'Morning', enabled: true, type: 'schedule', config, lastRun: null, ...over });

test('schedule fires inside its window, once', () => {
  const r = sched({ time: '09:00' });
  assert.strictEqual(evaluate([r], ctx()).fired.length, 1);
  assert.strictEqual(evaluate([r], ctx({ now: at(9, 9) })).fired.length, 1);
  assert.strictEqual(evaluate([r], ctx({ now: at(9, 11) })).fired.length, 0);
  assert.strictEqual(evaluate([r], ctx({ now: at(8, 59) })).fired.length, 0);
  assert.strictEqual(evaluate([{ ...r, lastRun: at(9, 0) }], ctx({ now: at(9, 1) })).fired.length, 0);
  // Ran yesterday: fires again today.
  assert.strictEqual(evaluate([{ ...r, lastRun: at(9, 0, -1) }], ctx()).fired.length, 1);
});

test('schedule respects days', () => {
  const r = sched({ time: '09:00', days: [1, 2, 3, 4, 5] });
  assert.strictEqual(evaluate([r], ctx()).fired.length, 0); // Sunday
  assert.strictEqual(evaluate([r], ctx({ now: at(9, 0, 1) })).fired.length, 1); // Monday
});

test('start conditions skip with a reason', () => {
  const r = sched({ time: '09:00', minBattery: 50, skipIfCleanedWithinH: 12, onlyWhenAway: true });
  assert.match(evaluate([r], ctx({ battery: 30 })).skipped[0].reason, /battery/);
  assert.match(evaluate([r], ctx({ lastCleanEnd: at(1, 0) })).skipped[0].reason, /cleaned within/);
  assert.match(evaluate([r], ctx({ presence: { configured: true, home: true } })).skipped[0].reason, /home/);
  assert.match(evaluate([r], ctx({ active: true })).skipped[0].reason, /already/);
  assert.match(evaluate([r], ctx({ connected: false })).skipped[0].reason, /offline/);
  assert.strictEqual(evaluate([r], ctx({ presence: { configured: true, home: false, since: 0 } })).fired.length, 1);
});

test('quiet hours wrap midnight and block starts', () => {
  const q = { enabled: true, start: '22:00', end: '07:00' };
  assert.ok(inQuietHours(at(23, 0), q));
  assert.ok(inQuietHours(at(6, 59), q));
  assert.ok(!inQuietHours(at(7, 0), q));
  assert.ok(!inQuietHours(at(23, 0), { ...q, enabled: false }));
  const r = sched({ time: '06:30' });
  assert.match(evaluate([r], ctx({ now: at(6, 30), quiet: q })).skipped[0].reason, /quiet/);
});

test('away rule waits for the delay, then fires once per departure', () => {
  const r = { id: 2, name: 'When I leave', enabled: true, type: 'away', config: { delayMin: 10 }, lastRun: null };
  const left = at(9, 0);
  const p = { configured: true, home: false, since: left };
  assert.strictEqual(evaluate([r], ctx({ now: left + 5 * 60000, presence: p })).fired.length, 0);
  assert.strictEqual(evaluate([r], ctx({ now: left + 10 * 60000, presence: p })).fired.length, 1);
  assert.strictEqual(evaluate([{ ...r, lastRun: left + 10 * 60000 }], ctx({ now: left + 11 * 60000, presence: p })).fired.length, 0);
  assert.strictEqual(evaluate([r], ctx({ presence: { configured: true, home: true, since: left } })).fired.length, 0);
});

test('arrive rule docks an active robot', () => {
  const r = { id: 3, name: 'Home', enabled: true, type: 'arrive', config: {}, lastRun: null };
  const p = { configured: true, home: true, since: at(9, 0) };
  const res = evaluate([r], ctx({ now: at(9, 1), presence: p, active: true }));
  assert.strictEqual(res.fired[0].action, 'dock');
  assert.strictEqual(evaluate([r], ctx({ now: at(9, 1), presence: p, active: false })).fired.length, 0);
});

test('disabled rules never fire; nextScheduled finds the soonest', () => {
  assert.strictEqual(evaluate([sched({ time: '09:00' }, { enabled: false })], ctx()).fired.length, 0);
  const n = nextScheduled([sched({ time: '08:00' }), sched({ time: '10:00' }, { id: 2 })], at(9, 0));
  assert.strictEqual(n.ruleId, 2);
  assert.strictEqual(nextScheduled([sched({ time: '08:00' })], at(9, 0)).t, at(8, 0, 1));
});

test('validate rejects bad rules', () => {
  assert.throws(() => validate({ name: '', type: 'schedule', config: { time: '09:00' } }));
  assert.throws(() => validate({ name: 'x', type: 'schedule', config: { time: '25:00' } }));
  assert.throws(() => validate({ name: 'x', type: 'nope', config: {} }));
  assert.ok(validate({ name: 'x', type: 'away', config: { delayMin: 5 } }));
});

test('settings map to robot fields and back', () => {
  assert.deepStrictEqual(buildDelta({ passes: 'two' }), { noAutoPasses: true, twoPass: true });
  assert.deepStrictEqual(buildDelta({ alwaysFinish: true }), { binPause: false });
  assert.deepStrictEqual(buildDelta({ volume: 140 }), { audio: { volume: 100 } });
  assert.throws(() => buildDelta({ passes: 'three' }));
  const s = readSettings({ noAutoPasses: false, twoPass: false, binPause: true, openOnly: null, audio: { volume: 40 } });
  assert.strictEqual(s.passes.value, 'auto');
  assert.strictEqual(s.alwaysFinish.value, false);
  assert.strictEqual(s.edgeClean.supported, false);
  assert.strictEqual(s.volume.value, 40);
});
