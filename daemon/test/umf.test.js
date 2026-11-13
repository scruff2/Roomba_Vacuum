'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseMap, parseCoverage, matchHistory } = require('../umf');
const { signRequest } = require('../cloud');

// A tiny made-up map in iRobot's UMF shape (not anyone's real home).
const pts = { 1: [0, 0], 2: [4, 0], 3: [4, 3], 4: [0, 3], 5: [4, 6], 6: [0, 6], 7: [1, 1], 8: [2, 1], 9: [2, 2], 10: [1, 2] };
const umf = {
  format_version: '4.9.0',
  maps: [{
    map_header: { id: 'MAP', version: 'V2', name: 'Test Floor', area: 24, resolution: 0.105, user_orientation_rad: 0 },
    points2d: Object.entries(pts).map(([id, coordinates]) => ({ id: String(id), coordinates })),
    regions: [
      { id: '0', name: 'Kitchen', region_type: 'kitchen', geometry: { type: 'polygon', ids: [['1', '2', '3', '4', '1']] } },
      { id: '1', name: 'Hallway', region_type: 'hallway', geometry: { type: 'polygon', ids: [['4', '3', '5', '6', '4']] } }
    ],
    zones: [{ id: '0', name: 'Litter Box', zone_type: 'pet', geometry: { type: 'polygon', ids: [['7', '8', '9', '10', '7']] } }],
    keepoutzones: [],
    doors: [{ id: '0', geometry: { type: 'linestring', ids: ['4', '3'] } }],
    borders: [{ id: '0', free_type: 'free', geometry: { type: 'polygon', ids: [['1', '2', '5', '6', '1']] } }],
    objects: [
      { object_type: 'oven', region_id: '0', geometry: { type: 'polygon', ids: [['7', '8', '9', '7']] }, system: { visible: true }, user: { hide: false } },
      { object_type: 'litter_box', region_id: '1', geometry: { type: 'polygon', ids: [['7', '8', '9', '7']] }, system: { visible: false }, user: { hide: false } },
      { object_type: 'shoe', region_id: '1', geometry: { type: 'polygon', ids: [['7', '8', '9', '7']] }, system: { visible: true }, user: { hide: true } }
    ],
    poses2d: [{ id: 'd', coordinates: [0.25, 0.02], ori_rad: 0.01 }],
    typed_poses: { dock_poses: { geometry: { type: 'multipose', ids: ['d'] } } },
    layers: [
      { layer_type: 'coverage', geometry: { type: 'multipoint2d', point_area: [0.1, 0.1], coordinates: [[1, 1], [1.1, 1], [1.2, 1]] } },
      { layer_type: 'dirt', geometry: { type: 'multipoint2d', coordinates: [[1, 1]] } }
    ]
  }]
};

test('parses rooms, zones, doors, objects and dock', () => {
  const m = parseMap(umf);
  assert.strictEqual(m.name, 'Test Floor');
  assert.deepStrictEqual(m.rooms.map((r) => [r.key, r.name, r.polygon.length]), [['0', 'Kitchen', 4], ['1', 'Hallway', 4]]);
  assert.deepStrictEqual(m.zones[0].key, 'z0');
  assert.deepStrictEqual(m.zones[0].polygon, [[1, 1], [2, 1], [2, 2], [1, 2]]);
  assert.strictEqual(m.doors.length, 1);
  assert.deepStrictEqual(m.objects.map((o) => [o.type, o.shown]), [['oven', true], ['litter_box', false]]);
  assert.deepStrictEqual(m.dock, { x: 0.25, y: 0.02, angle: 0.01 });
  assert.deepStrictEqual(m.bounds, { x0: 0, y0: 0, x1: 4, y1: 6 });
});

test('parses coverage cells and area', () => {
  const c = parseCoverage(umf);
  assert.strictEqual(c.cells.length, 3);
  assert.strictEqual(c.areaM2, 0);
  assert.deepStrictEqual(c.dirt, [[1, 1]]);
});

test('matches history by closest start, preferring records with map data', () => {
  const missions = [{ id: 'A', start: 1000000 }, { id: 'B', start: 5000000 }];
  const history = [
    { startTime: 991, done: 'stuck' },                                        // 9 s early, no map data
    { startTime: 1000, done: 'ok', sqft: 40, pmaps_info: [{ pmap_id: 'MAP', pmapv_id: 'V1' }] },
    { missionId: 'B', done: 'ok', pmaps: [{ MAP: 'V2' }] }
  ];
  const m = matchHistory(missions, history);
  assert.strictEqual(m.get('A').version, 'V1');
  assert.strictEqual(m.get('A').sqft, 40);
  assert.strictEqual(m.get('B').version, 'V2');
});

test('SigV4 signing matches the AWS test suite (get-vanilla)', () => {
  const h = signRequest({ host: 'example.amazonaws.com', path: '/', region: 'us-east-1', service: 'service', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z') });
  assert.match(h.authorization, /Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/);
});

test('a clean on a fresh map is flagged as lost', () => {
  const { offMap } = require('../umf');
  assert.strictEqual(offMap({ pmapId: 'NEW' }, 'SAVED'), true);
  assert.strictEqual(offMap({ pmapId: 'SAVED' }, 'SAVED'), false);
  assert.strictEqual(offMap({}, 'SAVED'), false);
  assert.strictEqual(offMap({ pmapId: 'NEW' }, null), false);
});
