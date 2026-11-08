#!/usr/bin/env node
// Research tool: fetch this robot's maps and mission history from iRobot's
// cloud (read-only GETs) and save the raw JSON for inspection. Uses the login
// stored by bin/sweep-cloud-login. Prints only a summary.
//
//   node tools/cloud-fetch.js [outDir]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cloud } = require('../daemon/cloud');

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'sweep', 'config.json'), 'utf8'));
const out = process.argv[2] || path.join(os.homedir(), '.local', 'share', 'sweep', 'cloud');
fs.mkdirSync(out, { recursive: true });
const save = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));

(async () => {
  const cloud = new Cloud({ email: cfg.cloudEmail, country: cfg.cloudCountry || 'US' });
  await cloud.login();
  const pmaps = await cloud.pmaps(cfg.blid);
  save('pmaps.json', pmaps);
  console.log(`maps: ${pmaps.length}`);
  for (const p of pmaps) {
    const d = p.active_pmapv_details || {};
    console.log(`- ${p.pmap_id} active ${p.active_pmapv_id} user ${p.user_pmapv_id} "${(d.map_header || {}).name || ''}"`);
    console.log(`  regions: ${(d.regions || []).map((r) => `${r.id}=${r.name || '?'}(${r.region_type || ''})`).join(', ')}`);
    console.log(`  zones: ${(d.zones || []).map((z) => `${z.id}=${z.name || '?'}`).join(', ')}  keepouts: ${(d.keepoutzones || []).length}`);
    const umf = await cloud.umf(cfg.blid, p.pmap_id, p.active_pmapv_id);
    save(`umf-${p.pmap_id}-${p.active_pmapv_id}.json`, umf);
    const m = (umf.maps || [])[0] || {};
    console.log(`  umf ${umf.format_version}: ${Object.keys(m).map((k) => `${k}:${Array.isArray(m[k]) ? m[k].length : typeof m[k]}`).join(' ')}`);
  }
  const history = await cloud.missionHistory(cfg.blid, 15);
  save('missionhistory.json', history);
  console.log(`missions in history: ${history.length}`);
  for (const h of history.slice(0, 8)) {
    const pi = (h.pmaps_info || [])[0] || {};
    console.log(`- ${new Date(h.startTime * 1000).toLocaleString()} ${h.done || ''} ${h.durationM ?? ''} min, map ${pi.pmapv_id || '-'}, keys: ${Object.keys(h).slice(0, 14).join(',')}`);
  }
  console.log(`saved raw JSON in ${out}`);
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
