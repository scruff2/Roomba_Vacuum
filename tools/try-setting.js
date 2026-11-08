#!/usr/bin/env node
// Research tool: write a setting ("delta") through sweepd, check whether the
// robot echoes it back (most refusals are silent), then restore the original.
//
//   node tools/try-setting.js '{"schedHold": true}'           write, verify, restore
//   node tools/try-setting.js '{"schedHold": true}' --keep    write and verify only
//
// Never use this for pmaps, pmapShare, featureFlags or anything you can't restore.

const BASE = process.env.SWEEP_URL || 'http://127.0.0.1:8099';
const delta = JSON.parse(process.argv[2] || 'null');
const keep = process.argv.includes('--keep');
const WAIT_MS = 15000;

const raw = async () => (await fetch(`${BASE}/api/raw`)).json();
const write = async (d) => {
  const res = await fetch(`${BASE}/api/raw/delta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sweep': '1' }, body: JSON.stringify(d) });
  if (!res.ok) throw new Error((await res.json()).error);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pick = (state, d) => Object.fromEntries(Object.keys(d).map((k) => [k, state[k] === undefined ? null : state[k]]));

async function waitFor (expected) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    const now = pick(await raw(), expected);
    if (same(now, expected)) return { echoed: true, after: Date.now() - t0, now };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { echoed: false, now: pick(await raw(), expected) };
}

(async () => {
  if (!delta || typeof delta !== 'object') { console.error('usage: try-setting.js \'{"key": value}\' [--keep]'); process.exit(1); }
  const original = pick(await raw(), delta);
  console.log('original:', JSON.stringify(original));
  await write(delta);
  const r = await waitFor(delta);
  console.log(r.echoed ? `ECHOED after ${(r.after / 1000).toFixed(1)}s:` : `NOT echoed within ${WAIT_MS / 1000}s; robot now reports:`, JSON.stringify(r.now));
  if (!keep && !same(original, delta)) {
    // Only restore keys the robot actually had; null means it never reported them.
    const restore = Object.fromEntries(Object.entries(original).filter(([, v]) => v !== null));
    if (Object.keys(restore).length) {
      await write(restore);
      const back = await waitFor(restore);
      console.log(back.echoed ? 'restored:' : 'RESTORE NOT CONFIRMED, robot reports:', JSON.stringify(back.now));
    }
  }
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
