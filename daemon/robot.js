'use strict';
// Owns the single local MQTT connection the robot allows. Merges reported
// state, emits updates, and knows the robot's command quirks.

const EventEmitter = require('events');
const dorita980 = require('dorita980');

// This firmware rejects dorita980's default TLS 1.2 cipher, so TLS 1.3 suites go first.
const CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:AES128-SHA256';
// train = mapping run (explores without vacuuming to build or improve the map).
const COMMANDS = ['start', 'clean', 'pause', 'resume', 'stop', 'dock', 'find', 'evac', 'train'];

class Robot extends EventEmitter {
  constructor (cfg, log = console) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.state = {};
    this.connected = false;
    this.lastFullAt = 0;
    this.client = null;
    this.refreshing = false;
  }

  connect () {
    const c = this.cfg;
    const client = new dorita980.Local(c.blid, c.password, c.ip, {
      ciphers: process.env.ROBOT_CIPHERS || CIPHERS,
      onError: (e) => this.log.error('robot error:', e.message)
    });
    this.client = client;
    client.on('connect', () => {
      if (client !== this.client) return;
      this.connected = true;
      this.emit('connection', true);
    });
    client.on('close', () => {
      if (client !== this.client) return;
      if (this.connected) { this.connected = false; this.emit('connection', false); }
    });
    client.on('update', (msg) => {
      if (client !== this.client) return;
      const r = msg && msg.state && msg.state.reported;
      if (!r) return;
      Object.assign(this.state, r);
      // On connect the robot sends its whole state, including the counters
      // that never update live; remember when so callers can wait for it.
      if (Object.keys(r).length > 20) { this.lastFullAt = Date.now(); this.emit('full', this.state); }
      this.emit('update', r, this.state);
    });
  }

  // Reconnect to get fresh counters (bbrun, bbswitch, ...), which the robot
  // only sends as part of the full state on a new connection.
  async refresh (timeoutMs = 20000) {
    if (this.refreshing) return this.state;
    this.refreshing = true;
    const before = this.lastFullAt;
    try {
      const old = this.client;
      this.client = null;
      if (old) await new Promise((resolve) => old.end(true, resolve));
      this.connected = false;
      this.connect();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        const check = () => { if (this.lastFullAt > before) { clearTimeout(t); this.off('full', check); resolve(); } };
        this.on('full', check);
      });
      return this.state;
    } finally {
      this.refreshing = false;
    }
  }

  async command (cmd) {
    if (!COMMANDS.includes(cmd)) throw new Error(`unknown command: ${cmd}`);
    if (!this.connected) throw new Error('robot not connected');
    const phase = (this.state.cleanMissionStatus || {}).phase;
    // Mid-clean, the j-series treats "dock" as "pause"; pause first, then dock.
    if (cmd === 'dock' && phase === 'run') {
      await this.client.pause();
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    await this.client[cmd]();
  }

  // Start a clean of specific rooms; args come from rooms.buildCleanArgs.
  async cleanRooms (args) {
    if (!this.connected) throw new Error('robot not connected');
    await this.client.cleanRoom(args);
  }

  async setPreferences (delta) {
    if (!this.connected) throw new Error('robot not connected');
    await this.client.setPreferences(delta);
  }

  close () {
    const c = this.client;
    this.client = null;
    if (c) c.end(true);
  }
}

module.exports = { Robot, COMMANDS };
