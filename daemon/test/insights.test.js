'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runMinutes, reviewMission, healthWarnings } = require('../insights');

const MIN = 60000;
// A mission shaped like the ones sweepd records.
const mission = ({ id = 'm', rooms = [{ id: '1', name: 'Hallway' }], run = 5, bumps = 100, evacs = 1, panics = 0, stuck = 0, result = 'completed', errors = [], extra = {} } = {}) => ({
  id, rooms, result, errors, start: 0, end: (run + 2) * MIN,
  phases: [[0, 'run'], [run * MIN, 'hmPostMsn'], [(run + 1) * MIN, 'charge']],
  stats: { bumps, evacs, panics, stuck, cleanMinutes: run, ...extra }
});

test('run time is the sum of run phases', () => {
  const m = mission();
  m.phases = [[0, 'run'], [3 * MIN, 'hmMidMsn'], [5 * MIN, 'charge'], [10 * MIN, 'run'], [14 * MIN, 'hmPostMsn']];
  assert.strictEqual(runMinutes(m), 7);
});

test('a normal room clean is good', () => {
  const r = reviewMission(mission({ run: 5.3, bumps: 144 }));
  assert.strictEqual(r.verdict, 'good');
  assert.deepStrictEqual(r.reasons, []);
});

test('a short, bumpy clean with no bin emptying is poor, with reasons', () => {
  // Today's litter-box zone runs: ~1.5 min out, ~60 bumps/min, no evac.
  const r = reviewMission(mission({ rooms: [{ id: 'z0', name: 'Litter box' }], run: 1.6, bumps: 90, evacs: 0, panics: 1 }));
  assert.strictEqual(r.verdict, 'poor');
  assert.match(r.reasons[0], /only out for 1.6 min/);
  assert.ok(r.reasons.some((x) => /bumped into things 56 times a minute/.test(x)));
  assert.ok(r.reasons.some((x) => /didn't empty the bin/.test(x)));
  assert.ok(r.advice.length >= 2);
});

test('compares against the usual run time for the same rooms', () => {
  const history = [mission({ id: 'a', run: 20 }), mission({ id: 'b', run: 22 })].map((m) => ({ ...m, review: { verdict: 'good' } }));
  const r = reviewMission(mission({ id: 'c', run: 8, bumps: 150 }), history);
  assert.strictEqual(r.verdict, 'poor');
  assert.match(r.reasons[0], /under half its usual 22 min/);
});

test('errors and stopped missions are labelled, not judged', () => {
  assert.strictEqual(reviewMission(mission({ result: 'stopped', run: 1 })).verdict, 'stopped');
  assert.strictEqual(reviewMission(mission({ errors: [[0, 17]] })).verdict, 'error');
});

test('warns when brush stalls climb well above the lifetime rate', () => {
  const state = { runtimeStats: { hr: 300, min: 0 }, bbrun: { nMBStll: 600, nPanics: 300 } }; // 2 stalls/h lifetime
  const missions = [mission({ run: 60, extra: { brushStalls: 6 } }), mission({ run: 60, extra: { brushStalls: 6 } })]; // 6/h recently
  const w = healthWarnings({ state, missions });
  assert.ok(w.some((x) => x.key === 'brushStalls' && x.level === 'warn'));
  // Not enough recent cleaning to judge: no warning.
  assert.ok(!healthWarnings({ state, missions: [mission({ run: 30, extra: { brushStalls: 6 } })] }).some((x) => x.key === 'brushStalls'));
});

test('warns about flickering charging contacts and restarts from counter snapshots', () => {
  const day = 86400000;
  const snapshots = [
    { t: 10 * day, counters: { chargeChatters: 80, chargeErrors: 0, navResets: 72, mobilityResets: 80, memoryResets: 25 } },
    { t: 0, counters: { chargeChatters: 60, chargeErrors: 0, navResets: 70, mobilityResets: 79, memoryResets: 24 } }
  ];
  const keys = healthWarnings({ state: {}, snapshots }).map((x) => x.key);
  assert.ok(keys.includes('contacts'));
  assert.ok(keys.includes('resets'));
  assert.ok(!keys.includes('chargeErrors'));
});

test('battery warnings depend on age and mid-mission recharges', () => {
  const now = new Date(2026, 10, 8).getTime();
  const state = { batInfo: { mDate: '2022-7-11' } };
  const recharge = mission(); recharge.phases.splice(1, 0, [MIN, 'hmMidMsn']);
  assert.ok(healthWarnings({ state, missions: [recharge, recharge], now }).some((x) => x.key === 'battery' && x.level === 'warn'));
  assert.ok(healthWarnings({ state, missions: [], now }).some((x) => x.key === 'batteryAge' && x.level === 'info'));
});
