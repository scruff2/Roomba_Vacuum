'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MissionTracker, snapshotCounters, diffCounters, finalizeCounters } = require('../missions');
const { Store } = require('../db');

const base = (over = {}) => ({
  batPct: 99,
  bbswitch: { nBumper: 1000, nDrops: 5 },
  bbrun: { nStuck: 2, nCliffsF: 50, nEvacs: 10, nPanics: 3 },
  runtimeStats: { hr: 10, min: 50 },
  cleanMissionStatus: { cycle: 'none', phase: 'charge', mssnM: 0, error: 0, missionId: 'A', initiator: 'localApp' },
  ...over
});
const cms = (s, m) => ({ ...s, cleanMissionStatus: { ...s.cleanMissionStatus, ...m } });

test('counter diff folds runtime hours and minutes', () => {
  const a = snapshotCounters(base());
  const b = snapshotCounters(base({ bbswitch: { nBumper: 1030, nDrops: 5 }, runtimeStats: { hr: 11, min: 5 } }));
  const d = diffCounters(a, b);
  assert.strictEqual(d.bumps, 30);
  assert.strictEqual(d.wheelDrops, 0);
  assert.strictEqual(d.cleanMinutes, 15);
  assert.ok(!('cleanHoursTotal' in d));
});

test('tracks a full mission from start to finish', () => {
  const t = new MissionTracker();
  let s = base();
  assert.deepStrictEqual(t.feed(s, 0), []);
  s = cms(s, { cycle: 'clean', phase: 'run', missionId: 'B', mssnStrtTm: 100 });
  const ev = t.feed(s, 1000);
  assert.deepStrictEqual(ev.map((e) => e.type), ['start', 'phase']);
  assert.strictEqual(t.current.start, 100000);
  s = { ...cms(s, { mssnM: 12, sqft: 80 }), batPct: 70 };
  t.feed(s, 2000);
  s = cms(s, { phase: 'hmPostMsn' });
  t.feed(s, 3000);
  s = cms(s, { cycle: 'none', phase: 'charge' });
  const end = t.feed(s, 4000);
  assert.strictEqual(end[0].type, 'end');
  const m = end[0].mission;
  assert.strictEqual(m.result, 'completed');
  assert.strictEqual(m.missionMinutes, 12);
  assert.strictEqual(m.sqft, 80);
  assert.strictEqual(m.batteryMin, 70);
  assert.deepStrictEqual(m.phases.map((p) => p[1]), ['run', 'hmPostMsn']);
  finalizeCounters(m, base({ bbswitch: { nBumper: 1100, nDrops: 6 } }));
  assert.strictEqual(m.stats.bumps, 100);
  assert.strictEqual(m.stats.wheelDrops, 1);
  assert.strictEqual(t.current, null);
});

test('user-docked mission is "stopped", errored one is "error"', () => {
  const t = new MissionTracker();
  let s = cms(base(), { cycle: 'clean', phase: 'run', missionId: 'C' });
  t.feed(s, 0);
  s = cms(s, { phase: 'hmUsrDock' }); t.feed(s, 1);
  assert.strictEqual(t.feed(cms(s, { cycle: 'none', phase: 'charge' }), 2)[0].mission.result, 'stopped');

  s = cms(base(), { cycle: 'clean', phase: 'run', missionId: 'D' });
  t.feed(s, 10);
  const err = t.feed(cms(s, { phase: 'stuck', error: 17 }), 11);
  assert.ok(err.some((e) => e.type === 'error' && e.code === 17));
  assert.strictEqual(t.feed(cms(s, { cycle: 'none', phase: 'charge', error: 0 }), 12)[0].mission.result, 'error');
});

test('the stale mission id reported while still docked does not open a mission', () => {
  const t = new MissionTracker();
  let s = cms(base(), { cycle: 'clean', phase: 'charge', missionId: 'OLD' });
  assert.deepStrictEqual(t.feed(s, 0), []);
  s = cms(s, { phase: 'run', missionId: 'NEW' });
  const ev = t.feed(s, 1);
  assert.deepStrictEqual(ev.map((e) => e.type), ['start', 'phase']);
  assert.strictEqual(t.current.id, 'NEW');
});

test('a recharge mid-mission does not end it', () => {
  const t = new MissionTracker();
  let s = cms(base(), { cycle: 'clean', phase: 'run', missionId: 'E' });
  t.feed(s, 0);
  s = cms(s, { phase: 'hmMidMsn' }); t.feed(s, 1);
  s = cms(s, { phase: 'charge' });
  assert.ok(!t.feed(s, 2).some((e) => e.type === 'end'));
  assert.ok(t.current);
});

test('resumed open mission ends when the robot is found idle', () => {
  const open = { id: 'F', start: 0, phases: [[0, 'run']], errors: [], countersStart: {}, missionMinutes: 3, sawFinish: false };
  const t = new MissionTracker(open);
  const ev = t.feed(base(), 5);
  assert.strictEqual(ev[0].type, 'end');
  assert.strictEqual(ev[0].mission.id, 'F');
});

test('store round-trips missions and finds the open one', () => {
  const st = new Store(':memory:');
  st.saveMission({ id: 'X', start: 1, end: null, result: null });
  assert.strictEqual(st.openMission().id, 'X');
  st.saveMission({ id: 'X', start: 1, end: 5, result: 'completed', missionMinutes: 4 });
  assert.strictEqual(st.openMission(), null);
  assert.strictEqual(st.lastCompletedEnd(), 5);
  assert.strictEqual(st.missions().length, 1);
});
