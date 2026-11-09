'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toEntry, desiredEntries, merge, same } = require('../robotsched');
const { evaluate, robotHolds } = require('../automations');

const store = {
  pmapId: 'MAP', version: 'V1', template: { ordered: 1 },
  rooms: [{ id: '0', type: 'rid', name: 'Kitchen', params: { noAutoPasses: true, twoPass: false } }, { id: '0', type: 'zid', name: 'Litter Box', params: null }]
};
const rule = (config, over = {}) => ({ id: 7, name: 'Morning', enabled: true, type: 'schedule', config: { time: '09:30', onRobot: true, ...config }, ...over });
const at = (h, m, day = 0) => new Date(2026, 10, 8 + day, h, m, 0, 0).getTime(); // 2026-11-08 is a Sunday

test('a whole-house rule becomes a plain start entry', () => {
  assert.deepStrictEqual(toEntry(rule({ days: [5, 1, 3] }), store, []), {
    enabled: true, type: 0, start: { day: [1, 3, 5], hour: 9, min: 30 }, cmd: { command: 'start', ordered: 1 }
  });
});

test('a room rule carries map, version and per-room params, like the fired test', () => {
  const e = toEntry(rule({ rooms: ['0', 'z0'] }), store, []);
  assert.deepStrictEqual(e.cmd, {
    command: 'start', ordered: 1, pmap_id: 'MAP', user_pmapv_id: 'V1',
    regions: [{ params: { noAutoPasses: true, twoPass: false }, region_id: '0', type: 'rid' }, { region_id: '0', type: 'zid' }]
  });
  assert.deepStrictEqual(e.start.day, [0, 1, 2, 3, 4, 5, 6]);
});

test('routines resolve to their rooms; only enabled on-robot schedules are included', () => {
  const routines = [{ id: 'r1', name: 'Evening', rooms: ['z0'] }];
  const { entries, errors } = desiredEntries([
    rule({ routineId: 'r1' }),
    rule({}, { id: 8, enabled: false }),
    rule({ onRobot: false }, { id: 9 }),
    rule({ routineId: 'gone' }, { id: 10, name: 'Broken' })
  ], store, routines);
  assert.deepStrictEqual(entries.map((x) => x.ruleId), [7]);
  assert.strictEqual(entries[0].entry.cmd.regions[0].type, 'zid');
  assert.match(errors[0].error, /routine/);
});

test('merging keeps the iRobot app\'s entries and replaces Sweep\'s old ones', () => {
  const app = { enabled: true, type: 0, start: { day: [6], hour: 10, min: 0 }, cmd: { command: 'start', ordered: 1 } };
  const oldSweep = { enabled: true, type: 0, start: { day: [1], hour: 9, min: 0 }, cmd: { command: 'start', ordered: 1 } };
  const newSweep = { ...oldSweep, start: { day: [1], hour: 9, min: 30 } };
  // The robot may return keys in another order; entries still match.
  const robot = [app, { cmd: oldSweep.cmd, start: oldSweep.start, type: 0, enabled: true }];
  const { list, foreign } = merge(robot, [oldSweep], [newSweep]);
  assert.deepStrictEqual(foreign, [app]);
  assert.ok(same(list, [app, newSweep]));
  assert.throws(() => merge([], [], new Array(22).fill(newSweep)), /at most 21/);
});

test('Sweep\'s own scheduler leaves on-robot rules to the robot', () => {
  const ctx = { now: at(9, 30), connected: true, active: false, battery: 90, presence: { configured: false }, quiet: { enabled: false } };
  assert.strictEqual(evaluate([rule({})], ctx).fired.length, 0);
  assert.strictEqual(evaluate([rule({ onRobot: false })], ctx).fired.length, 1);
});

test('holds pause a robot schedule shortly before a run that should be skipped', () => {
  const base = { connected: true, active: false, battery: 90, presence: { configured: false }, quiet: { enabled: false } };
  const r = rule({ skipIfCleanedWithinH: 12 });
  // Cleaned two hours ago, run due in 2 minutes: hold until 5 min after.
  const h = robotHolds([r], { ...base, now: at(9, 28), lastCleanEnd: at(7, 30) });
  assert.strictEqual(h.length, 1);
  assert.match(h[0].reason, /cleaned within/);
  assert.strictEqual(h[0].until, at(9, 35));
  // Too early, too late, or nothing blocking: no hold.
  assert.strictEqual(robotHolds([r], { ...base, now: at(9, 20), lastCleanEnd: at(7, 30) }).length, 0);
  assert.strictEqual(robotHolds([r], { ...base, now: at(9, 30), lastCleanEnd: at(7, 30) }).length, 0);
  assert.strictEqual(robotHolds([r], { ...base, now: at(9, 28), lastCleanEnd: null }).length, 0);
  // Quiet hours and presence count; offline doesn't.
  assert.strictEqual(robotHolds([rule({})], { ...base, now: at(9, 28), quiet: { enabled: true, start: '09:00', end: '10:00' } }).length, 1);
  assert.strictEqual(robotHolds([rule({})], { ...base, now: at(9, 28), connected: false }).length, 0);
});
