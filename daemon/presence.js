'use strict';
// Works out whether anyone is home by checking whether their phones answer
// on the LAN. Phones doze their Wi-Fi, so someone only counts as gone after
// none of their devices has answered for `awayAfterMin` minutes.

const { execFile } = require('child_process');

function run (cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout))));
}

async function deviceSeen (ip) {
  if (!/^[\d.]+$/.test(ip)) return false;
  if ((await run('ping', ['-c', '1', '-W', '1', ip])) !== null) return true;
  // A dozing phone often ignores ping but still answers ARP.
  const neigh = await run('ip', ['neigh', 'show', ip]);
  return !!neigh && /REACHABLE|DELAY|PROBE/.test(neigh);
}

class Presence {
  constructor (store, onChange) {
    this.store = store;
    this.onChange = onChange;
    this.lastSeen = {};
    this.home = null;
    this.since = null;
  }

  config () { return this.store.get('presence', { devices: [], awayAfterMin: 15 }); }

  state () {
    const c = this.config();
    return {
      configured: c.devices.length > 0,
      home: this.home,
      since: this.since,
      awayAfterMin: c.awayAfterMin,
      devices: c.devices.map((d) => ({ ...d, lastSeen: this.lastSeen[d.ip] || null }))
    };
  }

  async check (now = Date.now()) {
    const c = this.config();
    if (!c.devices.length) { this.home = null; this.since = null; return; }
    await Promise.all(c.devices.map(async (d) => { if (await deviceSeen(d.ip)) this.lastSeen[d.ip] = now; }));
    const window = (c.awayAfterMin || 15) * 60000;
    const home = c.devices.some((d) => this.lastSeen[d.ip] && now - this.lastSeen[d.ip] < window);
    if (home !== this.home) {
      const first = this.home === null;
      this.home = home;
      // At startup we don't know when people left; treat it as "just now".
      this.since = now;
      if (!first) this.onChange(home);
    }
  }
}

module.exports = { Presence };
