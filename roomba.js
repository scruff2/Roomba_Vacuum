#!/usr/bin/env node
// Command-line client for sweepd. The robot accepts only one local
// connection, which sweepd holds, so everything goes through its API.

const BASE = process.env.SWEEP_URL || 'http://127.0.0.1:8099';

async function api (method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Sweep': '1' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (e) {
    console.error(`Can't reach sweepd at ${BASE}. Start it with: systemctl --user start sweepd`);
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`Error: ${data.error || res.status}`); process.exit(1); }
  return data;
}

const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');

const commands = {
  async status () {
    const s = await api('GET', '/api/status');
    const lines = [
      `Name:      ${s.name || '—'}`,
      `Robot:     ${s.connected ? 'connected' : 'NOT connected'}`,
      `State:     ${s.phaseLabel || '—'}${s.active ? ` (${s.cycle})` : ''}`,
      `Battery:   ${s.battery ?? '—'}%`,
      `Bin:       ${s.bin ? (s.bin.full ? 'FULL' : 'ok') : '—'}`,
      `Wi-Fi:     ${s.rssi ?? '—'} dBm`
    ];
    if (s.error) lines.push(`Error:     ${s.error} – ${s.errorText}`);
    if (s.active && s.mission) lines.push(`Mission:   started ${fmtTime(s.mission.start)}, ${s.missionMinutes ?? 0} min`);
    if (s.next) lines.push(`Next:      ${s.next.name} at ${fmtTime(s.next.t)}`);
    console.log(lines.join('\n'));
  },
  async settings (...pairs) {
    if (pairs.length) {
      const body = {};
      for (const p of pairs) {
        const [k, v] = p.split('=');
        body[k] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
      }
      const r = await api('PUT', '/api/settings', body);
      console.log(r.confirmed ? 'Saved on the robot.' : 'Sent, but the robot has not confirmed yet.');
    }
    const { settings } = await api('GET', '/api/settings');
    for (const [k, s] of Object.entries(settings)) {
      console.log(`${k.padEnd(13)} ${String(s.supported ? s.value : 'n/a').padEnd(12)} ${s.label}${s.choices ? ` (${s.choices.join('/')})` : ''}`);
    }
  },
  async missions (limit = '10') {
    const list = await api('GET', `/api/missions?limit=${Number(limit) || 10}`);
    if (!list.length) return console.log('No missions recorded yet.');
    for (const m of list) {
      const st = m.stats || {};
      console.log(`${fmtTime(m.start).padEnd(24)} ${String(m.result || 'running').padEnd(10)} ${String(m.missionMinutes ?? '—').padStart(4)} min  ${String(m.sqft ?? '—').padStart(4)} sqft  bumps ${st.bumps ?? '—'}`);
    }
  },
  async log (limit = '20') {
    for (const e of (await api('GET', `/api/log?limit=${Number(limit) || 20}`)).reverse()) {
      console.log(`${fmtTime(e.t).padEnd(24)} ${e.kind.padEnd(11)} ${e.message}`);
    }
  },
  async health () { console.log(JSON.stringify(await api('GET', '/api/health'), null, 2)); }
};

for (const cmd of ['start', 'pause', 'resume', 'stop', 'dock', 'find', 'evac']) {
  commands[cmd] = async () => { await api('POST', `/api/cmd/${cmd}`); console.log(`Sent: ${cmd}`); };
}

const [cmd, ...args] = process.argv.slice(2);
if (commands[cmd]) commands[cmd](...args);
else {
  console.log(`Usage: node roomba.js <command>   (talks to sweepd at ${BASE})

  status                     Battery, bin, state, current mission
  start | pause | resume | stop | dock
  find                       Play a sound to locate the robot
  evac                       Empty the bin into the Clean Base
  settings [key=value ...]   Show settings, or change some (e.g. passes=two volume=60)
  missions [n]               Recent missions
  log [n]                    Recent activity
  health                     Battery, counters, firmware (JSON)`);
}
