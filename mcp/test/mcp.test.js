'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../sweep-mcp');
const { TOOLS, resolveRooms, findRoutine } = require('../tools');

const ROOMS = [
  { id: '0', type: 'rid', name: 'Kitchen', passes: 'one' },
  { id: '1', type: 'rid', name: 'Hallway', passes: 'two' },
  { id: '2', type: 'rid', name: 'Entrance Hallway', passes: 'one' },
  { id: 'z0', type: 'zid', name: 'Litter Box', passes: 'one' }
];
const STATUS = { connected: true, name: 'Robot', phase: 'charge', phaseLabel: 'Docked', battery: 90, bin: { full: false }, rooms: ROOMS, routines: [{ id: 'r1', name: 'Litter patrol', rooms: ['1'] }] };

// A fake API that records every write.
function fakeApi () {
  const writes = [];
  return {
    writes,
    get: async (p) => { if (p === '/api/status') return STATUS; throw new Error(`unexpected GET ${p}`); },
    post: async (p, b) => { writes.push([p, b]); return { ok: true }; },
    put: async (p, b) => { writes.push([p, b]); return { ok: true }; }
  };
}
const call = (server, name, args) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const parse = (r) => JSON.parse(r.result.content[0].text);

test('rooms resolve by key, exact name or unique part of a name', () => {
  assert.deepStrictEqual(resolveRooms(['kitchen', 'z0', 'litter'], ROOMS).map((r) => r.id), ['0', 'z0', 'z0']);
  assert.strictEqual(resolveRooms(['hallway'], ROOMS)[0].id, '1'); // exact beats "Entrance Hallway"
  assert.strictEqual(resolveRooms(['entrance'], ROOMS)[0].id, '2');
  assert.throws(() => resolveRooms(['hall'], ROOMS), /matches Hallway and Entrance Hallway/);
  assert.throws(() => resolveRooms(['garage'], ROOMS), /no room called/);
  assert.throws(() => resolveRooms([], ROOMS), /at least one/);
  assert.strictEqual(findRoutine('litter', STATUS.routines).id, 'r1');
});

test('initialize, list tools and ignore notifications', async () => {
  const s = createServer(fakeApi());
  const init = await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.strictEqual(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.capabilities.tools);
  assert.strictEqual(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('clean_rooms') && names.includes('get_status') && names.includes('go_home'));
  assert.ok(!names.some((n) => /raw|delta|setting/.test(n)), 'no raw robot writes are offered');
  assert.strictEqual((await s.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

test('every tool has a description and an object schema', () => {
  for (const t of TOOLS) {
    assert.ok(t.description.length > 10, t.name);
    assert.strictEqual(t.inputSchema.type, 'object', t.name);
    assert.strictEqual(typeof t.annotations.readOnlyHint, 'boolean', t.name);
  }
});

test('clean_rooms preview sends nothing; a real call sends room keys in order', async () => {
  const api = fakeApi(); const s = createServer(api);
  const p = parse(await call(s, 'clean_rooms', { rooms: ['Hallway', 'kitchen'], preview: true }));
  assert.strictEqual(p.wouldClean, 'Hallway (two passes) → Kitchen (one pass)');
  assert.strictEqual(api.writes.length, 0);
  await call(s, 'clean_rooms', { rooms: ['Hallway', 'kitchen'] });
  assert.deepStrictEqual(api.writes, [['/api/rooms/clean', { rooms: ['1', '0'] }]]);
});

test('routines and commands hit the right endpoints', async () => {
  const api = fakeApi(); const s = createServer(api);
  await call(s, 'run_routine', { routine: 'Litter patrol' });
  await call(s, 'go_home', {});
  await call(s, 'find_robot', {});
  assert.deepStrictEqual(api.writes.map((w) => w[0]), ['/api/routines/r1/clean', '/api/cmd/dock', '/api/cmd/find']);
});

test('tool failures come back as readable errors', async () => {
  const s = createServer(fakeApi());
  const r = await call(s, 'clean_rooms', { rooms: ['garage'] });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /no room called “garage”/);
});
