#!/usr/bin/env node
// One real MCP client against ./server/mcp: the Codex CLI's own. Not part of `npm test`.
// It starts `codex app-server` with one extra MCP server configured (the small server
// below, served by serveMcp on stdio), and asks Codex, over the app-server protocol, what
// it found there (mcpServerStatus/list) and to call a tool (mcpServer/tool/call). No model
// call is made. The only process started is the app-server (which starts the MCP server
// as its child); it is stopped at the end through its pid.
//
//   node scripts/mcp-real-check.mjs [/path/to/codex]
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../server/codex-rpc.mjs';
import { serveMcp } from '../server/mcp.mjs';

const self = fileURLToPath(import.meta.url);
if (process.env.MCP_REAL_CHECK_SERVER) {
  // The MCP server Codex starts: it records every line it is sent, so the check can show what a real client says.
  const log = process.env.MCP_REAL_CHECK_SERVER;
  process.stdin.on('data', chunk => appendFileSync(log, chunk));
  const served = serveMcp({ name: 'real-check', version: '0.0.1', instructions: 'A check.', tools: [
    { name: 'show', description: 'The draft as it is now.', inputSchema: { type: 'object', properties: { file: { type: 'string' } } } },
    { name: 'fail', description: 'Always fails.' }],
    call: async (name, args) => { if (name === 'fail') throw new Error('This tool always fails.'); return { files: { [args.file || 'draft.md']: 'the live draft' } }; } });
  await served.done;
  process.exit(0);
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-real-check-')), log = path.join(dir, 'received.jsonl');
const quote = value => JSON.stringify(value);
const rpc = new CodexRpc({ command: [process.argv[2] || 'codex', 'app-server',
  '-c', `mcp_servers.leyline_check.command=${quote(process.execPath)}`, '-c', `mcp_servers.leyline_check.args=${quote([self])}`,
  '-c', `mcp_servers.leyline_check.env=${`{ MCP_REAL_CHECK_SERVER = ${quote(log)} }`}`], cwd: dir });
let ok = false;
try {
  const child = rpc.start();
  console.log(`app-server started (pid ${child.pid})`);
  await rpc.call('initialize', { clientInfo: { name: 'mcp-real-check', title: 'MCP real check', version: '0.0.0' }, capabilities: null });
  rpc.notify('initialized', {});
  const thread = await rpc.call('thread/start', { cwd: dir, approvalPolicy: 'never', sandbox: 'read-only' });
  let status = null;
  for (let attempt = 0; attempt < 100 && !(status?.tools && Object.keys(status.tools).length); attempt++) {
    const listed = await rpc.call('mcpServerStatus/list', { detail: 'full', threadId: thread.thread.id }).catch(error => ({ error: error.message }));
    status = (listed.data || []).find(server => server.name === 'leyline_check') || status;
    if (listed.error) console.log(`mcpServerStatus/list: ${listed.error}`);
    if (!(status?.tools && Object.keys(status.tools).length)) await new Promise(resolve => setTimeout(resolve, 200));
  }
  console.log(`Codex's view of the server: serverInfo=${quote(status?.serverInfo)} capabilities=${quote(status?.serverCapabilities)} tools=${quote(Object.keys(status?.tools || {}))} toolsError=${quote(status?.toolsError)}`);
  const called = await rpc.call('mcpServer/tool/call', { threadId: thread.thread.id, server: 'leyline_check', tool: 'show', arguments: { file: 'notes.md' } }).catch(error => ({ error: error.message }));
  console.log(`mcpServer/tool/call show: ${quote(called)}`);
  const failed = await rpc.call('mcpServer/tool/call', { threadId: thread.thread.id, server: 'leyline_check', tool: 'fail', arguments: {} }).catch(error => ({ error: error.message }));
  console.log(`mcpServer/tool/call fail: ${quote(failed)}`);
  const received = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  console.log('What the real client sent, in order:');
  for (const message of received) console.log(`  ${message.method ?? '(reply)'} ${quote(message.params ?? {}).slice(0, 260)}`);
  ok = Object.keys(status?.tools || {}).length === 2 && quote(called).includes('the live draft') && quote(failed).includes('This tool always fails.');
} catch (error) { console.log(`FAILED: ${error.stack || error}`); }
finally {
  const pid = rpc.proc?.pid;
  rpc.close();
  if (pid) { const end = Date.now() + 5000; const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } }; while (alive() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); if (alive()) process.kill(pid, 'SIGKILL'); }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(ok ? 'observed: a real MCP client listed both tools, called one, and read a failed call' : 'NOT observed: see above');
process.exit(ok ? 0 : 1);
