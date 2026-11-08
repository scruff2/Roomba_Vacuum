'use strict';
// Parses iRobot's "UMF" map format (from the cloud) into plain shapes for
// drawing. Shapes reference point ids in points2d; coordinates are metres,
// with the dock/start pose at the origin.

function pointIndex (m) {
  const idx = new Map();
  for (const p of m.points2d || []) idx.set(String(p.id), p.coordinates);
  return idx;
}

function resolve (ids, idx) {
  return (ids || []).map((id) => idx.get(String(id))).filter(Boolean);
}

// First ring of a polygon geometry, without the repeated closing point.
function polygon (geometry, idx) {
  if (!geometry || !Array.isArray(geometry.ids)) return [];
  const ring = Array.isArray(geometry.ids[0]) ? geometry.ids[0] : geometry.ids;
  const pts = resolve(ring, idx);
  if (pts.length > 1) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  }
  return pts;
}

function boundsOf (polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

function parseMap (umf) {
  const m = umf && umf.maps && umf.maps[0];
  if (!m) throw new Error('map has no data');
  const idx = pointIndex(m);
  const header = m.map_header || {};
  const rooms = (m.regions || []).map((r) => ({
    key: String(r.id), id: String(r.id), name: r.name || null, type: r.region_type || null,
    polygon: polygon(r.geometry, idx)
  }));
  const zones = (m.zones || []).map((z) => ({
    key: `z${z.id}`, id: String(z.id), name: z.name || null, type: z.zone_type || null,
    polygon: polygon(z.geometry, idx)
  }));
  const keepouts = (m.keepoutzones || []).map((k) => ({ id: String(k.id), name: k.name || null, polygon: polygon(k.geometry, idx) }));
  const doors = (m.doors || []).map((d) => resolve(d.geometry && d.geometry.ids, idx)).filter((l) => l.length === 2);
  const borders = (m.borders || []).map((b) => ({ type: b.free_type || null, polygon: polygon(b.geometry, idx) }));
  // Keep objects unless the user hid or deleted them. iRobot marks some as
  // not shown (system.visible false) though the robot still knows them, like
  // the litter box; those are flagged so the map can draw them faintly.
  const objects = (m.objects || [])
    .filter((o) => !(o.user && (o.user.hide || o.user.deleted_dateutc)) && !(o.system && o.system.deleted_dateutc))
    .map((o) => ({
      type: o.object_type || null, region: o.region_id != null ? String(o.region_id) : null,
      shown: !(o.system && o.system.visible === false), polygon: polygon(o.geometry, idx)
    }));
  const poses = new Map((m.poses2d || []).map((p) => [String(p.id), p]));
  const dockId = m.typed_poses && m.typed_poses.dock_poses && m.typed_poses.dock_poses.geometry && m.typed_poses.dock_poses.geometry.ids && m.typed_poses.dock_poses.geometry.ids[0];
  const dockPose = dockId != null ? poses.get(String(dockId)) : null;
  return {
    id: header.id || null,
    version: header.version || null,
    name: header.name || null,
    area: header.area || null,
    resolution: header.resolution || null,
    orientation: header.user_orientation_rad || 0,
    rooms, zones, keepouts, doors, borders, objects,
    dock: dockPose ? { x: dockPose.coordinates[0], y: dockPose.coordinates[1], angle: dockPose.ori_rad || 0 } : { x: 0, y: 0, angle: 0 },
    bounds: boundsOf([...rooms.map((r) => r.polygon), ...borders.map((b) => b.polygon)])
  };
}

// Coverage from a mission's map version: the cells it cleaned (point_area
// squares), plus escape events and dirt.
function parseCoverage (umf) {
  const m = umf && umf.maps && umf.maps[0];
  if (!m) throw new Error('map has no data');
  const layer = (t) => (m.layers || []).find((l) => l.layer_type === t);
  const cov = layer('coverage');
  const geom = (cov && cov.geometry) || {};
  const area = Array.isArray(geom.point_area) ? geom.point_area : [0.105, 0.105];
  const dirt = layer('dirt');
  const escapes = layer('escape_events');
  return {
    version: (m.map_header || {}).version || null,
    cell: area,
    cells: geom.coordinates || [],
    areaM2: Math.round((geom.coordinates || []).length * area[0] * area[1] * 10) / 10,
    dirt: (dirt && dirt.geometry && dirt.geometry.coordinates) || [],
    escapes: ((escapes && escapes.geometry && escapes.geometry.list) || []).map((e) => (Array.isArray(e) ? e.slice(0, 2) : e && e.coordinates ? e.coordinates.slice(0, 2) : null)).filter(Boolean)
  };
}

// Pair cloud mission-history records with Sweep's missions: by mission id
// when the record has one, otherwise by closest start time (within 2 min).
// Records with map data win over empty ones (e.g. a 0-minute "stuck" start).
function matchHistory (sweepMissions, history) {
  const pairs = [];
  for (const h of history || []) {
    const info = (h.pmaps_info && h.pmaps_info[0]) || null;
    const versions = h.pmaps && h.pmaps[0] ? Object.entries(h.pmaps[0])[0] : null;
    const record = {
      pmapId: info ? info.pmap_id : versions ? versions[0] : null,
      version: info ? info.pmapv_id : versions ? versions[1] : null,
      sqft: h.sqft ?? null,
      done: h.done || null,
      dirt: h.dirt ?? null,
      runMinutes: h.runM ?? null,
      avoidance: h.odoaFeats || null
    };
    for (const m of sweepMissions) {
      let score = null;
      if (h.missionId && m.id === h.missionId) score = -1;
      else if (h.startTime && Math.abs(m.start - h.startTime * 1000) < 120000) score = Math.abs(m.start - h.startTime * 1000) + (record.version ? 0 : 1e6);
      if (score != null) pairs.push({ score, mission: m.id, record });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const out = new Map(); const used = new Set();
  for (const p of pairs) {
    if (out.has(p.mission) || used.has(p.record)) continue;
    out.set(p.mission, p.record); used.add(p.record);
  }
  return out;
}

module.exports = { parseMap, parseCoverage, matchHistory };
