'use strict';
// The tools Sweep offers to AI assistants over MCP. Each one wraps a safe part
// of Sweep's local API and returns short, readable results. Deliberately left
// out: raw robot settings (/api/raw/delta), which can write anything to the
// robot, and other low-level endpoints.

// A small client for Sweep's API. `fetchImpl` is injectable for tests.
function makeApi (base = 'http://127.0.0.1:8099', fetchImpl = globalThis.fetch) {
  async function call (method, path, body) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: method === 'GET' ? {} : { 'X-Sweep': '1', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new Error(`Sweep's service isn't reachable at ${base} (${e.message}). Start it with: systemctl --user start sweepd`);
    }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) };
}

// "2026-11-08 19:20" in local time.
function when (ms) {
  if (!ms) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Find rooms and zones by key ("3", "z0") or name ("kitchen", "Litter box").
// Exact names win; otherwise a name that uniquely contains the text.
function resolveRooms (wanted, rooms) {
  if (!Array.isArray(wanted) || !wanted.length) throw new Error('name at least one room');
  const names = rooms.map((r) => r.name).join(', ');
  return wanted.map((w) => {
    const byKey = rooms.find((r) => r.id === String(w));
    if (byKey) return byKey;
    const n = norm(w);
    const exact = rooms.filter((r) => norm(r.name) === n);
    if (exact.length === 1) return exact[0];
    const partial = rooms.filter((r) => norm(r.name).includes(n));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`“${w}” matches ${partial.map((r) => r.name).join(' and ')}; be more specific`);
    throw new Error(`no room called “${w}”. Rooms: ${names}`);
  });
}

function findRoutine (wanted, routines) {
  const n = norm(wanted);
  const hit = routines.find((r) => r.id === wanted) || routines.find((r) => norm(r.name) === n) ||
    (routines.filter((r) => norm(r.name).includes(n)).length === 1 ? routines.find((r) => norm(r.name).includes(n)) : null);
  if (!hit) throw new Error(`no routine called “${wanted}”. Routines: ${routines.map((r) => r.name).join(', ') || 'none yet'}`);
  return hit;
}

const STARTERS = { localApp: 'Sweep', rmtApp: 'iRobot app', schedule: 'robot schedule', manual: 'robot button', localSched: 'robot schedule' };

function missionLine (m) {
  return {
    id: m.id,
    started: when(m.start),
    ended: when(m.end),
    minutes: m.missionMinutes ?? null,
    sqft: m.sqft ?? null,
    result: m.result || (m.end ? 'unknown' : 'in progress'),
    startedBy: m.initiator ? (STARTERS[m.initiator] || m.initiator) : null,
    rooms: (m.rooms || []).map((r) => r.name || r.id),
    errors: (m.errors || []).map((e) => e.text || e.code || e),
    review: m.review ? (m.review.verdict || null) : null
  };
}

function statusSummary (s) {
  return {
    connected: s.connected,
    robot: s.name,
    state: s.phaseLabel || s.phase,
    cleaning: !!s.active,
    battery: s.battery,
    binFull: s.bin ? !!s.bin.full : null,
    error: s.error ? (s.errorText || `error ${s.error}`) : null,
    currentMission: s.mission ? missionLine(s.mission) : null,
    nextAutomation: s.next || null,
    quietHoursNow: !!s.quietNow,
    maintenanceDue: (s.maintenanceDue || []).map((m) => m.label || m.key || m),
    warnings: (s.warnings || []).map((w) => w.title),
    robotSchedules: s.robotSchedule || null,
    map: s.map ? { name: s.map.name, error: s.map.error } : null
  };
}

const READ = { readOnlyHint: true, openWorldHint: false };
const MOVE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const preview = { type: 'boolean', description: 'If true, only describe what would happen; the robot does nothing.' };

// Each tool: name, description, inputSchema, annotations, run(args, api).
const TOOLS = [
  {
    name: 'get_status',
    description: 'Current state of the Roomba: docked/cleaning/returning, battery, bin, errors, the clean in progress, care items due and warnings. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Robot status', ...READ },
    run: async (a, api) => statusSummary(await api.get('/api/status'))
  },
  {
    name: 'list_rooms',
    description: 'Rooms, clean zones and saved routines the robot can clean, with their names and number of passes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Rooms and routines', ...READ },
    run: async (a, api) => {
      const s = await api.get('/api/status');
      return {
        rooms: (s.rooms || []).map((r) => ({ key: r.id, name: r.name, kind: r.type === 'zid' ? 'clean zone' : 'room', passes: r.passes })),
        routines: (s.routines || []).map((r) => ({ id: r.id, name: r.name, rooms: r.rooms.map((k) => ((s.rooms || []).find((x) => x.id === k) || {}).name || k) }))
      };
    }
  },
  {
    name: 'recent_cleans',
    description: 'Recent cleaning runs, newest first: when, how long, area, result, rooms and Sweep\'s review.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many (default 10).' } } },
    annotations: { title: 'Recent cleans', ...READ },
    run: async (a, api) => (await api.get(`/api/missions?limit=${Math.min(Math.max(Number(a.limit) || 10, 1), 50)}`)).map(missionLine)
  },
  {
    name: 'cleaning_stats',
    description: 'Totals over a period: number of cleans, completed, minutes, area, bumps, times stuck, errors.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Period in days (default 30).' } } },
    annotations: { title: 'Cleaning stats', ...READ },
    run: async (a, api) => {
      const { missions, ...totals } = await api.get(`/api/stats?days=${Number(a.days) || 30}`);
      return totals;
    }
  },
  {
    name: 'robot_health',
    description: 'Battery age and cycles, charging problems, restarts and lifetime counters, plus Sweep\'s health warnings.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Robot health', ...READ },
    run: async (a, api) => {
      const [h, s] = await Promise.all([api.get('/api/health'), api.get('/api/status')]);
      return { battery: h.battery, charging: h.charging, resets: h.resets, cleaning: h.lifetime && h.lifetime.cleaning, warnings: s.warnings || [] };
    }
  },
  {
    name: 'maintenance',
    description: 'Care items (filter, brushes, wheels, sensors…) with how much life is left and which are due.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Maintenance', ...READ },
    run: async (a, api) => (await api.get('/api/maintenance')).map((m) => ({
      key: m.key, item: m.label, due: !!m.due, left: `${Math.round(Math.max(0, 1 - (m.fraction || 0)) * 100)}%`,
      remaining: m.remaining != null ? `${Math.round(m.remaining * 10) / 10} ${m.meter}` : null, lastDone: when(m.doneAt), tip: m.tip
    }))
  },
  {
    name: 'list_automations',
    description: 'Sweep\'s automations (schedules, presence triggers) and when the next one runs.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Automations', ...READ },
    run: async (a, api) => api.get('/api/automations')
  },
  {
    name: 'activity_log',
    description: 'Sweep\'s recent activity: commands, cleans, errors, automation decisions.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many entries (default 30).' } } },
    annotations: { title: 'Activity log', ...READ },
    run: async (a, api) => (await api.get(`/api/log?limit=${Math.min(Number(a.limit) || 30, 200)}`))
      .map((e) => ({ at: when(e.t), kind: e.kind, text: e.message }))
  },
  {
    name: 'clean_rooms',
    description: 'Send the robot to clean specific rooms or clean zones, in the order given. Use names like "Kitchen" or keys from list_rooms. Each room uses its saved number of passes. The robot leaves the dock.',
    inputSchema: {
      type: 'object',
      properties: {
        rooms: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Room or zone names (or keys), in cleaning order.' },
        preview
      },
      required: ['rooms']
    },
    annotations: { title: 'Clean rooms', ...MOVE },
    run: async (a, api) => {
      const s = await api.get('/api/status');
      const picked = resolveRooms(a.rooms, s.rooms || []);
      const plan = picked.map((r) => `${r.name} (${r.passes || 'one'} pass${r.passes === 'two' ? 'es' : ''})`).join(' → ');
      if (a.preview) return { wouldClean: plan, robotNow: s.phaseLabel || s.phase };
      await api.post('/api/rooms/clean', { rooms: picked.map((r) => r.id) });
      return { started: true, cleaning: plan };
    }
  },
  {
    name: 'run_routine',
    description: 'Run a saved routine (a named list of rooms), by name or id from list_rooms. The robot leaves the dock.',
    inputSchema: { type: 'object', properties: { routine: { type: 'string', description: 'Routine name or id.' }, preview }, required: ['routine'] },
    annotations: { title: 'Run routine', ...MOVE },
    run: async (a, api) => {
      const s = await api.get('/api/status');
      const r = findRoutine(a.routine, s.routines || []);
      const rooms = r.rooms.map((k) => ((s.rooms || []).find((x) => x.id === k) || {}).name || k).join(' → ');
      if (a.preview) return { wouldRun: r.name, rooms };
      await api.post(`/api/routines/${encodeURIComponent(r.id)}/clean`);
      return { started: true, routine: r.name, rooms };
    }
  },
  {
    name: 'clean_everywhere',
    description: 'Start a whole-house clean. The robot leaves the dock.',
    inputSchema: { type: 'object', properties: { preview } },
    annotations: { title: 'Clean everywhere', ...MOVE },
    run: async (a, api) => {
      if (a.preview) return { wouldStart: 'whole-house clean' };
      await api.post('/api/cmd/start');
      return { started: true };
    }
  }
];

// Simple robot commands, each its own tool.
const SIMPLE = [
  ['pause', 'pause', 'Pause the clean in progress (the robot stops where it is).'],
  ['resume', 'resume', 'Resume a paused clean.'],
  ['go_home', 'dock', 'End the clean and send the robot back to its dock.'],
  ['stop', 'stop', 'Stop the clean and leave the robot where it is (it does not go home).'],
  ['find_robot', 'find', 'Make the robot play a sound so you can find it.'],
  ['empty_bin', 'evac', 'Empty the robot\'s bin into the Clean Base (only while docked).']
];
for (const [name, cmd, description] of SIMPLE) {
  TOOLS.push({
    name, description,
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: description.split(' (')[0].replace(/\.$/, ''), ...MOVE },
    run: async (a, api) => { await api.post(`/api/cmd/${cmd}`); return { sent: name }; }
  });
}

TOOLS.push({
  name: 'mark_maintenance_done',
  description: 'Record that a care item was just done (e.g. "cleanFilter"), resetting its reminder. Keys come from the maintenance tool.',
  inputSchema: { type: 'object', properties: { item: { type: 'string', description: 'Care item key.' } }, required: ['item'] },
  annotations: { title: 'Mark care done', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (a, api) => {
    const items = await api.get('/api/maintenance');
    if (!items.some((m) => m.key === a.item)) throw new Error(`unknown care item “${a.item}”. Items: ${items.map((m) => m.key).join(', ')}`);
    await api.post(`/api/maintenance/${a.item}/done`);
    return { done: a.item };
  }
});

module.exports = { TOOLS, makeApi, resolveRooms, findRoutine, statusSummary, missionLine, when };
