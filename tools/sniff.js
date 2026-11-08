#!/usr/bin/env node
// Low-level MQTT sniffer: subscribes to every topic it can and logs every
// packet the robot sends, so we can find telemetry beyond the state shadow.
//
//   node tools/sniff.js [seconds] [--get]
//   --get   also publish an empty message to the shadow "get" topic (read-only request)
//
// Needs the robot's single local connection: stop sweepd first.

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const cfg = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config', 'sweep', 'config.json'), 'utf8'));
const secs = Number(process.argv[2]) || 60;
const doGet = process.argv.includes('--get');
// --clean: start a clean at the beginning, then pause + dock at the end
const doStart = process.argv.includes('--clean');
function cmd (command) {
  const msg = JSON.stringify({ command, time: Math.floor(Date.now() / 1000), initiator: 'localApp' });
  client.publish('cmd', msg, () => console.log(new Date().toLocaleTimeString(), 'sent', command));
}
const out = path.join(__dirname, '..', 'captures', `sniff-${Date.now()}.jsonl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const log = fs.createWriteStream(out);

const client = mqtt.connect(`mqtts://${cfg.ip}:8883`, {
  clientId: cfg.blid, username: cfg.blid, password: cfg.password,
  rejectUnauthorized: false, protocolVersion: 4, clean: false, reconnectPeriod: 0,
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:AES128-SHA256'
});

const topics = {};
client.on('connect', () => {
  console.log('connected; listening', secs, 's →', out);
  const subs = ['#', '$aws/#', `$aws/things/${cfg.blid}/#`, `$aws/things/${cfg.blid}/shadow/#`];
  for (const t of subs) {
    client.subscribe(t, { qos: 0 }, (err, granted) => console.log('subscribe', t, err ? err.message : JSON.stringify(granted)));
  }
  if (doStart) setTimeout(() => cmd('start'), 2500);
  if (doGet) {
    setTimeout(() => {
      const t = `$aws/things/${cfg.blid}/shadow/get`;
      client.publish(t, '', () => console.log('published', t));
    }, 1500);
  }
});
client.on('packetreceive', (p) => {
  if (p.cmd === 'pingresp') return;
  const rec = { t: Date.now(), cmd: p.cmd, topic: p.topic, len: p.payload ? p.payload.length : 0 };
  if (p.payload) {
    const s = p.payload.toString();
    try { rec.json = JSON.parse(s); } catch (e) { rec.raw = p.payload.toString('base64'); }
  }
  if (p.cmd !== 'publish') rec.packet = { granted: p.granted, returnCode: p.returnCode };
  log.write(JSON.stringify(rec) + '\n');
  const key = `${p.cmd} ${p.topic || ''}`;
  topics[key] = (topics[key] || 0) + 1;
});
client.on('error', (e) => console.log('error', e.message));
client.on('close', () => console.log('closed'));

if (doStart) {
  setTimeout(() => cmd('pause'), (secs - 6) * 1000);
  setTimeout(() => cmd('dock'), (secs - 3) * 1000);
}

setTimeout(() => {
  console.log('\nPacket counts by type/topic:');
  for (const [k, n] of Object.entries(topics).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), k);
  log.end(); client.end(true); setTimeout(() => process.exit(0), 300);
}, secs * 1000);
