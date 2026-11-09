#!/usr/bin/env node
'use strict';
// Sweep's MCP server: lets AI assistants (Claude Code, Claude Desktop, any MCP
// client) read the robot's state and send it to clean, through Sweep's local
// API. Speaks MCP over stdio (newline-delimited JSON-RPC 2.0) with no
// dependencies.
//
//   claude mcp add sweep -- node /path/to/Roomba_Vacuum/mcp/sweep-mcp.js
//
// SWEEP_URL overrides the API address (default http://127.0.0.1:8099).

const readline = require('readline');
const { TOOLS, makeApi } = require('./tools');

const SERVER = { name: 'sweep', version: '0.1.0' };
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Controls a Roomba robot vacuum through Sweep. Call get_status first. ' +
  'Use list_rooms for room names. Tools that move the robot (clean_rooms, run_routine, clean_everywhere) accept preview:true to describe the plan without moving it.';

function createServer (api) {
  async function handle (msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    const ok = (result) => (isRequest ? { jsonrpc: '2.0', id, result } : null);
    const fail = (code, message) => (isRequest ? { jsonrpc: '2.0', id, error: { code, message } } : null);

    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS
        });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === (params && params.name));
        if (!tool) return fail(-32602, `unknown tool: ${params && params.name}`);
        try {
          const out = await tool.run((params && params.arguments) || {}, api);
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
        } catch (e) {
          // Tool failures go back to the model as readable results, not protocol errors.
          return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (!isRequest) return null; // notifications such as notifications/initialized
        return fail(-32601, `method not found: ${method}`);
    }
  }
  return { handle };
}

function main () {
  const server = createServer(makeApi(process.env.SWEEP_URL || undefined));
  const rl = readline.createInterface({ input: process.stdin });
  const send = (m) => { if (m) process.stdout.write(JSON.stringify(m) + '\n'); };
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = server.handle(m).then(send, (e) => send({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32603, message: e.message } }));
      pending.add(p); p.finally(() => pending.delete(p));
    }
  });
  // Answer everything already asked before exiting.
  rl.on('close', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
}

if (require.main === module) main();
module.exports = { createServer };
