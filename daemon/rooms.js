'use strict';
// Room cleaning. The robot only knows rooms by number and never lists them
// locally, but when the iRobot app starts a room clean the robot reports that
// command (map id, map version, region ids) as its lastCommand. We learn rooms
// from those, let the user name them, and replay the same command shape.

// Pull the map and regions out of a reported lastCommand, or null if it
// wasn't a room/zone clean.
function extractRooms (cmd) {
  if (!cmd || cmd.command !== 'start' || !Array.isArray(cmd.regions) || !cmd.regions.length || !cmd.pmap_id) return null;
  const regions = cmd.regions
    .filter((r) => r && r.region_id != null)
    .map((r) => ({ id: String(r.region_id), type: r.type || 'rid', params: r.params || null }));
  // Keep any extra fields the firmware sent (e.g. params) so our commands match its shape.
  const { command, time, initiator, regions: _r, pmap_id: _p, user_pmapv_id: _v, ...extra } = cmd;
  return { pmapId: cmd.pmap_id, version: cmd.user_pmapv_id || null, regions, template: extra, time: cmd.time || null, initiator: initiator || null };
}

const EMPTY = { pmapId: null, version: null, template: {}, rooms: [] };

// Only commands from the iRobot app teach us anything. Our own commands come
// back as lastCommand too, and must not overwrite what the app sent, since
// the app uses the map version the robot accepts.
function isFromApp (cmd) { return !!cmd && cmd.initiator !== 'localApp'; }

// Merge rooms seen in a command into the stored set. Returns the new store
// and which room ids were new.
function mergeRooms (store, seen) {
  const s = { ...EMPTY, ...(store || {}), rooms: [...((store && store.rooms) || [])] };
  if (!seen) return { store: s, added: [], mapChanged: false };
  const mapChanged = !!s.pmapId && s.pmapId !== seen.pmapId;
  if (mapChanged) s.rooms = []; // a different map numbers its rooms differently
  s.pmapId = seen.pmapId;
  s.version = seen.version || s.version;
  s.template = seen.template || s.template;
  const added = [];
  for (const r of seen.regions) {
    const known = s.rooms.find((x) => x.id === r.id && x.type === r.type);
    if (known) {
      if (r.params) known.params = r.params;
    } else {
      s.rooms.push({ id: r.id, type: r.type, name: null, params: r.params, seenAt: seen.time ? seen.time * 1000 : Date.now() });
      added.push(r.id);
    }
  }
  return { store: s, added, mapChanged };
}

// The robot's current map version, from state.pmaps ([{pmapId: version}]).
function currentVersion (pmaps, pmapId) {
  for (const entry of pmaps || []) if (entry && entry[pmapId]) return entry[pmapId];
  return null;
}

function buildCleanArgs (store, pmaps, ids, { ordered = true } = {}) {
  if (!store || !store.pmapId) throw new Error('no rooms captured yet: start one room clean from the iRobot app first');
  if (!Array.isArray(ids) || !ids.length) throw new Error('choose at least one room');
  const regions = ids.map((id) => {
    const room = store.rooms.find((r) => r.id === String(id));
    if (!room) throw new Error(`unknown room ${id}`);
    // The app sends each room's cleaning settings (passes) with it; do the same.
    return room.params ? { params: room.params, region_id: room.id, type: room.type } : { region_id: room.id, type: room.type };
  });
  // Use the map version the iRobot app last used. The robot saves newer
  // versions locally after each clean but rejects them (error 224) until
  // they're synced; the app's version is the one it accepts.
  const version = store.version || currentVersion(pmaps, store.pmapId);
  return { ...(store.template || {}), ordered: ordered ? 1 : 0, pmap_id: store.pmapId, user_pmapv_id: version, regions };
}

function roomName (store, id) {
  const r = store && store.rooms && store.rooms.find((x) => x.id === String(id));
  return r ? (r.name || `Room ${r.id}`) : `Room ${id}`;
}

module.exports = { isFromApp, extractRooms, mergeRooms, buildCleanArgs, currentVersion, roomName, EMPTY };
