'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../maintenance');
const rooms = require('../rooms');

const state = (hr, min, evacs) => ({ runtimeStats: { hr, min }, bbrun: { nEvacs: evacs } });

test('meters read cleaning hours and bin emptyings', () => {
  assert.deepStrictEqual(m.meters(state(327, 30, 540)), { hours: 327.5, evacs: 540 });
  assert.deepStrictEqual(m.meters({}), { hours: null, evacs: null });
});

test('untracked items start counting from now', () => {
  const { records, changed } = m.ensureBaselines({}, state(327, 0, 540), 1000);
  assert.ok(changed);
  assert.strictEqual(records.cleanFilter.baseline, 327);
  assert.strictEqual(records.replaceBag.baseline, 540);
  assert.ok(!m.ensureBaselines(records, state(400, 0, 600)).changed);
  assert.ok(m.status(records, state(327, 0, 540)).every((s) => !s.due && s.used === 0));
});

test('items come due by usage and are announced once', () => {
  let { records } = m.ensureBaselines({}, state(100, 0, 10));
  const later = state(116, 0, 41);
  const due = m.newlyDue(records, later).map((d) => d.key).sort();
  assert.deepStrictEqual(due, ['cleanBrushes', 'cleanFilter', 'replaceBag']);
  const filter = m.status(records, later).find((s) => s.key === 'cleanFilter');
  assert.strictEqual(filter.used, 16);
  assert.strictEqual(filter.remaining, -1);
  records = { ...records, cleanFilter: { ...records.cleanFilter, notifiedAt: 5 } };
  assert.ok(!m.newlyDue(records, later).some((d) => d.key === 'cleanFilter'));
  // Marking done resets the count and the announcement.
  records = m.markDone(records, 'cleanFilter', later, 99);
  const after = m.status(records, later).find((s) => s.key === 'cleanFilter');
  assert.strictEqual(after.used, 0);
  assert.strictEqual(after.doneAt, 99);
  assert.strictEqual(after.notifiedAt, null);
});

test('intervals can be changed and are validated', () => {
  let { records } = m.ensureBaselines({}, state(100, 0, 10));
  records = m.setInterval(records, 'cleanFilter', 5);
  assert.ok(m.status(records, state(106, 0, 10)).find((s) => s.key === 'cleanFilter').due);
  assert.throws(() => m.setInterval(records, 'cleanFilter', 0));
  assert.throws(() => m.setInterval(records, 'nope', 5));
  assert.throws(() => m.markDone(records, 'cleanFilter', {}), /counters/);
});

test('per-room passes override what the app sent', () => {
  const store = {
    pmapId: 'P', version: 'V', template: { ordered: 1 },
    rooms: [
      { id: '0', type: 'rid', params: { noAutoPasses: true, twoPass: false } },
      { id: '1', type: 'rid', params: { noAutoPasses: true, twoPass: false }, passes: 'two' }
    ]
  };
  assert.strictEqual(rooms.roomPasses(store.rooms[0]), 'one');
  assert.strictEqual(rooms.roomPasses(store.rooms[1]), 'two');
  const args = rooms.buildCleanArgs(store, [], ['0', '1']);
  assert.deepStrictEqual(args.regions.map((r) => r.params), [
    { noAutoPasses: true, twoPass: false },
    { noAutoPasses: true, twoPass: true }
  ]);
});

test('routines need a name and known rooms', () => {
  const store = { rooms: [{ id: '0' }, { id: '1' }] };
  assert.deepStrictEqual(rooms.validateRoutine({ name: ' Evening ', rooms: [1, '0'] }, store), { name: 'Evening', rooms: ['1', '0'] });
  assert.throws(() => rooms.validateRoutine({ name: '', rooms: ['0'] }, store), /name/);
  assert.throws(() => rooms.validateRoutine({ name: 'x', rooms: [] }, store), /at least one/);
  assert.throws(() => rooms.validateRoutine({ name: 'x', rooms: ['9'] }, store), /unknown room/);
});
