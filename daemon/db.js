'use strict';
// SQLite storage for missions, samples, the event log, automations and
// small settings. Uses Node's built-in node:sqlite, so no native deps.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, start INTEGER, end INTEGER, open INTEGER DEFAULT 1,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS missions_start ON missions(start);
CREATE TABLE IF NOT EXISTS samples (
  t INTEGER NOT NULL, battery INTEGER, rssi INTEGER, phase TEXT, mission TEXT
);
CREATE INDEX IF NOT EXISTS samples_t ON samples(t);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL,
  message TEXT NOT NULL, data TEXT
);
CREATE INDEX IF NOT EXISTS events_t ON events(t);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL, config TEXT NOT NULL, last_run INTEGER
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

class Store {
  constructor (file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  saveMission (m) {
    this.db.prepare(`INSERT INTO missions (id, start, end, open, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET start = excluded.start, end = excluded.end, open = excluded.open, data = excluded.data`)
      .run(m.id, m.start, m.end, m.end ? 0 : 1, JSON.stringify(m));
  }

  openMission () {
    const row = this.db.prepare('SELECT data FROM missions WHERE open = 1 ORDER BY start DESC LIMIT 1').get();
    return row ? JSON.parse(row.data) : null;
  }

  missions ({ limit = 100, since = 0 } = {}) {
    return this.db.prepare('SELECT data FROM missions WHERE start >= ? ORDER BY start DESC LIMIT ?')
      .all(since, limit).map((r) => JSON.parse(r.data));
  }

  mission (id) {
    const row = this.db.prepare('SELECT data FROM missions WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }

  lastCompletedEnd () {
    const row = this.db.prepare("SELECT end FROM missions WHERE open = 0 AND json_extract(data, '$.result') IN ('completed','stopped') AND json_extract(data, '$.missionMinutes') > 0 ORDER BY end DESC LIMIT 1").get();
    return row ? row.end : null;
  }

  addSample (s) {
    this.db.prepare('INSERT INTO samples (t, battery, rssi, phase, mission) VALUES (?, ?, ?, ?, ?)')
      .run(s.t, s.battery ?? null, s.rssi ?? null, s.phase ?? null, s.mission ?? null);
  }

  samples ({ since = 0, until = Date.now(), mission = null } = {}) {
    if (mission) return this.db.prepare('SELECT t, battery, rssi, phase FROM samples WHERE mission = ? ORDER BY t').all(mission);
    return this.db.prepare('SELECT t, battery, rssi, phase FROM samples WHERE t BETWEEN ? AND ? ORDER BY t').all(since, until);
  }

  pruneSamples (olderThan) {
    this.db.prepare('DELETE FROM samples WHERE t < ? AND mission IS NULL').run(olderThan);
  }

  logEvent (kind, message, data = null, t = Date.now()) {
    const r = this.db.prepare('INSERT INTO events (t, kind, message, data) VALUES (?, ?, ?, ?)')
      .run(t, kind, message, data == null ? null : JSON.stringify(data));
    return { id: Number(r.lastInsertRowid), t, kind, message, data };
  }

  events ({ limit = 200, kind = null } = {}) {
    const rows = kind
      ? this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY t DESC LIMIT ?').all(kind, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY t DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
  }

  automations () {
    return this.db.prepare('SELECT * FROM automations ORDER BY id').all()
      .map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, type: r.type, config: JSON.parse(r.config), lastRun: r.last_run }));
  }

  saveAutomation (a) {
    if (a.id) {
      this.db.prepare('UPDATE automations SET name = ?, enabled = ?, type = ?, config = ? WHERE id = ?')
        .run(a.name, a.enabled ? 1 : 0, a.type, JSON.stringify(a.config || {}), a.id);
      return a.id;
    }
    const r = this.db.prepare('INSERT INTO automations (name, enabled, type, config) VALUES (?, ?, ?, ?)')
      .run(a.name, a.enabled === false ? 0 : 1, a.type, JSON.stringify(a.config || {}));
    return Number(r.lastInsertRowid);
  }

  deleteAutomation (id) { this.db.prepare('DELETE FROM automations WHERE id = ?').run(id); }
  markAutomationRun (id, t) { this.db.prepare('UPDATE automations SET last_run = ? WHERE id = ?').run(t, id); }

  get (key, fallback) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set (key, value) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}

module.exports = { Store };
