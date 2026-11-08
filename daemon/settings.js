'use strict';
// Maps the robot's raw preference fields to friendly settings and back.
// Suction (carpetBoost/vacHigh) and edge cleaning (openOnly) are left out:
// on the j8+ the robot silently ignores suction writes and doesn't support
// edge cleaning (see docs/ROOMBA_RESEARCH.md).
// Each setting reports whether this robot actually exposes it, so the app
// never shows a switch that silently does nothing.

const SETTINGS = {
  passes: {
    label: 'Cleaning passes', choices: ['auto', 'one', 'two'],
    read: (s) => (s.noAutoPasses === undefined ? undefined : !s.noAutoPasses ? 'auto' : s.twoPass ? 'two' : 'one'),
    write: (v) => ({ auto: { noAutoPasses: false, twoPass: false }, one: { noAutoPasses: true, twoPass: false }, two: { noAutoPasses: true, twoPass: true } })[v]
  },
  alwaysFinish: {
    label: 'Keep cleaning when bin is full', type: 'bool',
    read: (s) => (s.binPause == null ? undefined : !s.binPause),
    write: (v) => ({ binPause: !v })
  },
  childLock: {
    label: 'Child & pet lock', type: 'bool',
    read: (s) => (s.childLock == null ? undefined : !!s.childLock),
    write: (v) => ({ childLock: !!v })
  },
  ecoCharge: {
    label: 'Eco charging', type: 'bool',
    read: (s) => (s.ecoCharge == null ? undefined : !!s.ecoCharge),
    write: (v) => ({ ecoCharge: !!v })
  },
  volume: {
    label: 'Voice volume', type: 'int', min: 0, max: 100,
    read: (s) => (s.audio && s.audio.volume != null ? s.audio.volume : undefined),
    write: (v) => ({ audio: { volume: Math.max(0, Math.min(100, Math.round(Number(v)))) } })
  }
};

function readSettings (state) {
  const out = {};
  for (const [key, def] of Object.entries(SETTINGS)) {
    const value = def.read(state);
    out[key] = { label: def.label, type: def.type || 'choice', choices: def.choices, min: def.min, max: def.max, supported: value !== undefined, value: value ?? null };
  }
  return out;
}

function buildDelta (changes) {
  const delta = {};
  for (const [key, value] of Object.entries(changes)) {
    const def = SETTINGS[key];
    if (!def) throw new Error(`unknown setting: ${key}`);
    if (def.choices && !def.choices.includes(value)) throw new Error(`invalid value for ${key}: ${value}`);
    Object.assign(delta, def.write(value));
  }
  return delta;
}

module.exports = { SETTINGS, readSettings, buildDelta };
