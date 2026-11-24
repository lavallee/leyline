// The command table as an MCP server over stdio: the messages, both revisions of the
// protocol, a real child process on real pipes, and the bridge to a host's endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createMcpServer, serveMcp, describeTools, MCP_VERSION, MCP_LEGACY_VERSIONS } from '../server/mcp.mjs';
import { createCommandEndpoint, writeSession } from '../server/commands.mjs';
import { JsonRpcStdio } from '../server/jsonrpc-stdio.mjs';
import { fixture, tempDir, until } from './helpers.mjs';

const tools = [{ name: 'show', title: 'Show the draft', description: 'The draft as it is now.', inputSchema: { type: 'object', properties: { file: { type: 'string' } } } }, { name: 'edit', description: 'Replace text.' }];
const server = () => createMcpServer({ name: 'host', version: '1.2.3', title: 'Host', instructions: 'Use show first.', tools, call: async (name, args, { signal }) => {
  if (name === 'show') return { text: 'one two three', asked: args };
  if (args.find === 'missing') throw Object.assign(new Error('That text is not in the draft.'), { status: 409 });
  if (args.find === 'slow') await new Promise(resolve => signal.addEventListener('abort', resolve));
  return `replaced ${args.find}`;
} });
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('MCP 2025-11-25 and earlier: initialize, ping, tools/list and tools/call have the shapes the specification gives', async () => {
  const { handle } = server();
  assert.deepEqual(await handle(request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'client', version: '1' } })),
    { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'host', version: '1.2.3', title: 'Host' }, instructions: 'Use show first.' } });
  for (const version of MCP_LEGACY_VERSIONS) assert.equal((await handle(request(2, 'initialize', { protocolVersion: version }))).result.protocolVersion, version, 'a version it speaks is answered with the same one');
  assert.equal((await handle(request(3, 'initialize', { protocolVersion: '1999-01-01' }))).result.protocolVersion, '2025-11-25', 'any other is answered with one it does speak');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification gets no reply');
  assert.deepEqual(await handle(request('p', 'ping')), { jsonrpc: '2.0', id: 'p', result: {} });
  assert.deepEqual((await handle(request(4, 'tools/list', {}))).result, { tools: [
    { name: 'show', title: 'Show the draft', description: 'The draft as it is now.', inputSchema: { type: 'object', properties: { file: { type: 'string' } } } },
    { name: 'edit', description: 'Replace text.', inputSchema: { type: 'object' } }] });
  // A result that is an object is given both ways the specification names: as text and as structuredContent.
  assert.deepEqual((await handle(request(5, 'tools/call', { name: 'show', arguments: { file: 'draft.md' } }))).result,
    { content: [{ type: 'text', text: '{"text":"one two three","asked":{"file":"draft.md"}}' }], isError: false, structuredContent: { text: 'one two three', asked: { file: 'draft.md' } } });
  assert.deepEqual((await handle(request(6, 'tools/call', { name: 'edit', arguments: { find: 'two' } }))).result, { content: [{ type: 'text', text: 'replaced two' }], isError: false });
  // A tool that fails is a result with isError, for the agent to read; an unknown tool is a protocol error, -32602.
  assert.deepEqual((await handle(request(7, 'tools/call', { name: 'edit', arguments: { find: 'missing' } }))).result, { content: [{ type: 'text', text: 'That text is not in the draft.' }], isError: true });
  assert.deepEqual((await handle(request(8, 'tools/call', { name: 'delete-everything' }))).error, { code: -32602, message: 'Unknown tool: delete-everything' });
  assert.equal((await handle(request(9, 'tools/call', { name: 'show', arguments: 'not an object' }))).error.code, -32602);
  assert.deepEqual((await handle(request(10, 'resources/list'))).error, { code: -32601, message: 'Method not found: resources/list' });
  assert.equal((await handle({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, -32600);
  assert.equal((await handle('nonsense')).error.code, -32600);
  assert.equal(await handle({ jsonrpc: '2.0', id: 3, result: {} }), null, 'a reply to nothing is ignored');
  // A request that is withdrawn gets no reply, and the tool is told through its signal.
  const slow = handle(request(11, 'tools/call', { name: 'edit', arguments: { find: 'slow' } }));
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } }), null);
  assert.equal(await slow, null);
});

test('MCP 2026-07-28: server/discover, a version named on every request, and results that say they are complete', async () => {
  const { handle } = server(), meta = { 'io.modelcontextprotocol/protocolVersion': MCP_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
  assert.equal(MCP_VERSION, '2026-07-28');
  assert.deepEqual((await handle(request('discover-1', 'server/discover', { _meta: meta }))).result,
    { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 3600000, cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'host', version: '1.2.3', title: 'Host' } } });
  const listed = (await handle(request(1, 'tools/list', { _meta: meta }))).result;
  assert.deepEqual([listed.resultType, listed.ttlMs, listed.cacheScope, listed.tools.length], ['complete', 3600000, 'public', 2]);
  assert.ok(listed.tools.every(tool => tool.inputSchema && typeof tool.inputSchema === 'object'), 'inputSchema is always a JSON Schema object');
  assert.deepEqual((await handle(request(2, 'tools/call', { name: 'edit', arguments: { find: 'two' }, _meta: meta }))).result, { resultType: 'complete', content: [{ type: 'text', text: 'replaced two' }], isError: false });
  assert.deepEqual((await handle(request(3, 'tools/call', { name: 'edit', arguments: { find: 'missing' }, _meta: meta }))).result, { resultType: 'complete', content: [{ type: 'text', text: 'That text is not in the draft.' }], isError: true });
  assert.deepEqual((await handle(request(4, 'tools/call', { name: 'nope', _meta: meta }))).error, { code: -32602, message: 'Unknown tool: nope' });
  // A version it does not speak: the error the revision reserves for that, naming the ones it does.
  assert.deepEqual((await handle(request(5, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2031-01-01' } }))).error,
    { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28', ...MCP_LEGACY_VERSIONS], requested: '2031-01-01' } });
});

test('tools are checked when the server is made', () => {
  assert.deepEqual(describeTools({ show: async () => {}, 'edit.text': { description: 'Edit.' } }), [{ name: 'show', inputSchema: { type: 'object' } }, { name: 'edit.text', description: 'Edit.', inputSchema: { type: 'object' } }], 'a table of operations lists each under its name');
  for (const bad of [[{ name: 'has space' }], [{ name: '' }], [{ name: 'x'.repeat(129) }], [{}], [{ name: 'a' }, { name: 'a' }]]) assert.throws(() => describeTools(bad), TypeError);
  assert.throws(() => createMcpServer({ tools: [] }), /call/);
});

test('on streams: one message per line each way, nothing else written, a bad line answered and survived', async () => {
  const input = new PassThrough(), output = new PassThrough(), errors = [];
  let written = '';
  output.on('data', chunk => { written += chunk; });
  const served = serveMcp({ input, output, onError: error => errors.push(error), tools, call: async (name, args) => ({ said: `${name} ${args.text ?? ''}` }) });
  input.write('{ this is not JSON\n');
  input.write('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n');
  input.write(`${JSON.stringify(request(1, 'initialize', { protocolVersion: '2025-06-18' }))}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  // A message cut across writes, and a result with a line break in it: still one line out.
  const call = JSON.stringify(request(2, 'tools/call', { name: 'show', arguments: { text: 'two\nlines — é' } }));
  input.write(call.slice(0, 20)); input.write(Buffer.from(call.slice(20) + '\n'));
  input.end();
  await served.done;
  const lines = written.split('\n');
  assert.equal(lines.pop(), '', 'every message ends its line');
  const replies = lines.map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => [reply.id, reply.error?.code ?? 'ok']), [[null, -32700], [null, -32600], [1, 'ok'], [2, 'ok']]);
  assert.equal(replies[3].result.structuredContent.said, 'show two\nlines — é');
  assert.deepEqual(errors, []);
});

test('a real child process on real pipes: an MCP client lists and calls the tools, and the server leaves when the pipe closes', async t => {
  const stderr = [];
  const client = new JsonRpcStdio({ command: [process.execPath, fixture('mcp-server.mjs')], env: { ...process.env, MCP_MODE: 'direct' } });
  const noise = [], child = client.start();
  t.after(() => client.close());
  client.on('noise', line => noise.push(line)); child.stderr.on('data', chunk => stderr.push(String(chunk)));
  const hello = await client.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, 20000);
  assert.deepEqual([hello.protocolVersion, hello.serverInfo, hello.capabilities], ['2025-11-25', { name: 'direct', version: '0.0.1' }, { tools: { listChanged: false } }]);
  client.notify('notifications/initialized');
  assert.deepEqual((await client.call('tools/list', {}, 20000)).tools.map(tool => tool.name), ['show', 'edit']);
  assert.deepEqual((await client.call('tools/call', { name: 'show', arguments: { file: 'draft.md' } }, 20000)).structuredContent, { files: { 'draft.md': 'one two three' }, asked: { file: 'draft.md' } });
  assert.equal((await client.call('tools/call', { name: 'edit', arguments: { find: 'missing', replace: 'x' } }, 20000)).isError, true);
  await assert.rejects(client.call('tools/call', { name: 'nope' }, 20000), { code: -32602 });
  let exited = null;
  child.on('exit', code => { exited = code; });
  client.close();
  await until(() => exited !== null);
  assert.equal(exited, 0, 'closing its stdin is how the connection ends');
  assert.deepEqual([noise, stderr], [[], []], 'nothing on stdout that is not a message, and nothing on stderr');
});

test('the bridge: an agent\'s tool call reaches the host\'s operation over loopback, with the session key', async t => {
  const dir = await tempDir(t), seen = [];
  const endpoint = createCommandEndpoint({ port: () => host.address().port, operations: {
    show: data => { seen.push(['show', data]); return { files: { 'draft.md': 'the live draft' } }; },
    edit: data => { seen.push(['edit', data]); throw Object.assign(new Error('This command works only while you are handling a request on this page.'), { status: 409 }); } } });
  const host = http.createServer((req, res) => endpoint.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }));
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { host.closeAllConnections?.(); host.close(resolve); }));
  await writeSession({ app: 'testhost', name: 'agent-1', url: `http://127.0.0.1:${host.address().port}`, key: endpoint.key, stateDir: dir });
  const start = session => { const client = new JsonRpcStdio({ command: [process.execPath, fixture('mcp-server.mjs')], env: { ...process.env, MCP_MODE: 'bridge', MCP_STATE: dir, MCP_SESSION: session, MCP_PAGE: 'doc:main@1' } }); client.start(); t.after(() => client.close()); return client; };
  const client = start('agent-1');
  const hello = await client.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, 20000);
  assert.deepEqual([hello.serverInfo, hello.instructions], [{ name: 'testhost', version: '1.2.3' }, 'Use show before edit.']);
  const shown = await client.call('tools/call', { name: 'show', arguments: { file: 'draft.md' } }, 20000);
  assert.deepEqual([shown.isError, shown.structuredContent], [false, { files: { 'draft.md': 'the live draft' } }]);
  assert.deepEqual(seen, [['show', { page: 'doc:main@1', file: 'draft.md' }]], 'the host received the call, with the page the script was started for');
  // What the host refuses comes back in the host's own words, as a failed tool call the agent can read.
  const refused = await client.call('tools/call', { name: 'edit', arguments: { find: 'a', replace: 'b' } }, 20000);
  assert.deepEqual(refused, { content: [{ type: 'text', text: 'This command works only while you are handling a request on this page.' }], isError: true });
  // A key that no longer matches (the host rotated it): the same plain refusal a stranger gets.
  endpoint.rotate();
  assert.deepEqual((await client.call('tools/call', { name: 'show', arguments: {} }, 20000)), { content: [{ type: 'text', text: 'Not found.' }], isError: true });
  // No session file at all: the agent is told the host is not there.
  const lost = start('agent-2');
  assert.match((await lost.call('tools/call', { name: 'show', arguments: {} }, 20000)).content[0].text, /No testhost session found for "agent-2"/);
});
