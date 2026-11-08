'use strict';
// Desktop notifications through notify-send, with per-kind toggles.

const { execFile } = require('child_process');

const DEFAULTS = { stuck: true, binFull: true, finished: true, lowBattery: true, offline: true, automation: true, maintenance: true, review: true, health: true };

class Alerts {
  constructor (store, log = console) {
    this.store = store;
    this.log = log;
    this.lastSent = {};
  }

  config () { return { ...DEFAULTS, ...this.store.get('alerts', {}) }; }
  update (changes) {
    const next = { ...this.config() };
    for (const k of Object.keys(DEFAULTS)) if (k in changes) next[k] = !!changes[k];
    this.store.set('alerts', next);
    return next;
  }

  // kind: one of DEFAULTS' keys. Repeats of the same kind are held back for
  // `cooldownMs` so a flapping state doesn't spam the desktop.
  send (kind, title, body, { urgency = 'normal', cooldownMs = 5 * 60000 } = {}) {
    if (!this.config()[kind]) return false;
    const now = Date.now();
    if (this.lastSent[kind] && now - this.lastSent[kind] < cooldownMs) return false;
    this.lastSent[kind] = now;
    execFile('notify-send', ['-a', 'Sweep', '-i', 'sweep', '-u', urgency, title, body], (err) => {
      if (err) this.log.error('notify-send failed:', err.message);
    });
    return true;
  }
}

module.exports = { Alerts };
