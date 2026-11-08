'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isFromApp, extractRooms, mergeRooms, buildCleanArgs, currentVersion, roomName } = require('../rooms');

// Shape of a room clean started from the iRobot app, as the robot reports it.
const appCommand = (regions, extra = {}) => ({
  command: 'start', time: 1794160000, initiator: 'rmtApp', ordered: 1,
  pmap_id: 'FlMVrzHlRMKFOd8oMfA15Q', user_pmapv_id: '261108T181512',
  regions: regions.map((id) => ({ region_id: id, type: 'rid' })), ...extra
});

test('only the iRobot app\'s commands are learned from', () => {
  assert.ok(isFromApp({ initiator: 'rmtApp' }));
  assert.ok(!isFromApp({ initiator: 'localApp' }));
});

test('ignores commands that are not room cleans', () => {
  assert.strictEqual(extractRooms({ command: 'train', time: 1 }), null);
  assert.strictEqual(extractRooms({ command: 'start', time: 1, initiator: 'localApp' }), null);
  assert.strictEqual(extractRooms(null), null);
});

test('extracts map, regions and extra fields', () => {
  const seen = extractRooms(appCommand(['3', '7'], { params: { noAutoPasses: true } }));
  assert.strictEqual(seen.pmapId, 'FlMVrzHlRMKFOd8oMfA15Q');
  assert.strictEqual(seen.version, '261108T181512');
  assert.deepStrictEqual(seen.regions, [{ id: '3', type: 'rid', key: '3', params: null }, { id: '7', type: 'rid', key: '7', params: null }]);
  assert.deepStrictEqual(seen.template, { ordered: 1, params: { noAutoPasses: true } });
});

test('merging learns new rooms once and keeps names', () => {
  let { store, added } = mergeRooms(null, extractRooms(appCommand(['3'])));
  assert.deepStrictEqual(added, ['3']);
  store.rooms[0].name = 'Kitchen';
  ({ store, added } = mergeRooms(store, extractRooms(appCommand(['3', '7']))));
  assert.deepStrictEqual(added, ['7']);
  assert.strictEqual(store.rooms.find((r) => r.id === '3').name, 'Kitchen');
  assert.strictEqual(roomName(store, '7'), 'Room 7');
});

test('a different map resets rooms', () => {
  const { store } = mergeRooms(null, extractRooms(appCommand(['3'])));
  const other = extractRooms({ ...appCommand(['1']), pmap_id: 'OTHER' });
  const res = mergeRooms(store, other);
  assert.ok(res.mapChanged);
  assert.deepStrictEqual(res.store.rooms.map((r) => r.id), ['1']);
});

test('builds a clean command in the order given, using the app\'s map version and room params', () => {
  const cmd = appCommand(['3', '7']);
  cmd.regions[0].params = { noAutoPasses: true, twoPass: false };
  const { store } = mergeRooms(null, extractRooms(cmd));
  // The robot has saved a newer local version since; it rejects that one (error 224).
  const pmaps = [{ FlMVrzHlRMKFOd8oMfA15Q: '261108T182953' }];
  assert.strictEqual(currentVersion(pmaps, 'FlMVrzHlRMKFOd8oMfA15Q'), '261108T182953');
  const args = buildCleanArgs(store, pmaps, ['7', '3']);
  assert.deepStrictEqual(args, {
    ordered: 1, pmap_id: 'FlMVrzHlRMKFOd8oMfA15Q', user_pmapv_id: '261108T181512',
    regions: [{ region_id: '7', type: 'rid' }, { params: { noAutoPasses: true, twoPass: false }, region_id: '3', type: 'rid' }]
  });
  assert.throws(() => buildCleanArgs(store, pmaps, ['99']), /unknown room/);
  assert.throws(() => buildCleanArgs(store, pmaps, []), /at least one/);
  assert.throws(() => buildCleanArgs(null, pmaps, ['3']), /no rooms captured/);
});

test('a clean zone and a room with the same number stay distinct', () => {
  const room = extractRooms(appCommand(['0']));
  const zoneCmd = appCommand(['0']);
  zoneCmd.regions[0].type = 'zid';
  zoneCmd.regions[0].params = { noAutoPasses: true, twoPass: true };
  let { store } = mergeRooms(null, room);
  const res = mergeRooms(store, extractRooms(zoneCmd));
  store = res.store;
  assert.deepStrictEqual(res.added, ['z0']);
  store.rooms[0].name = 'Kitchen';
  assert.strictEqual(roomName(store, '0'), 'Kitchen');
  assert.strictEqual(roomName(store, 'z0'), 'Zone 0');
  const args = buildCleanArgs(store, [], ['z0', '0']);
  assert.deepStrictEqual(args.regions.map((r) => [r.type, r.region_id]), [['zid', '0'], ['rid', '0']]);
});
