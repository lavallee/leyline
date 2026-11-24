// A host's command operations as a Model Context Protocol server over stdio, so an agent
// that speaks MCP can reach the document without the host's command-line program. The
// same table of operations that ./commands.mjs serves over loopback is listed as MCP
// tools and called as MCP tool calls.
//
// Two ways to use it:
//   serveMcp({ tools, call })       the process that holds the operations serves them itself
//   serveMcpBridge({ app, name })   a small script the agent starts (MCP servers on stdio are
//                                   child processes of the agent) that passes each call on to
//                                   the host over loopback with the session key, exactly as
//                                   the host's CLI does (./commands.mjs `call`)
//
// The protocol surface is the least that lists and calls tools, written here with no
// dependency. Two revisions of the specification are spoken, because clients of both are
// in use (read 2026-11-24; the newer one is the current revision on that date):
//
//   2025-11-25 and earlier (2025-06-18, 2025-03-26, 2024-11-05): `initialize`, then
//     `notifications/initialized`, `ping`, `tools/list`, `tools/call`
//     https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
//     https://modelcontextprotocol.io/specification/2025-11-25/server/tools
//   2026-07-28: no handshake; every request names its protocol version in `_meta`;
//     `server/discover`; results carry `resultType`; `tools/list` carries `ttlMs` and `cacheScope`
//     https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
//     https://modelcontextprotocol.io/specification/2026-07-28/server/discover
//     https://modelcontextprotocol.io/specification/2026-07-28/server/tools
//   Both: one JSON-RPC 2.0 message per line on stdin and stdout, no embedded newlines,
//     nothing on stdout that is not a message
//     https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
//
// How far that was checked: the older handshake and the tool calls were run against a real
// client (Codex CLI 0.171.0, see scripts/mcp-real-check.mjs). The 2026-07-28 shapes follow
// the pages above as read and are covered by this package's own tests only; no 2026-07-28
// client was available to run against.
//
// What is not here: resources, prompts, sampling, elicitation, tasks, list-changed
// notifications, pagination (the whole list is one page), and the HTTP transport.
import { createLineReader } from './codex-rpc.mjs';
import { call as callHost } from './commands.mjs';
import { SHORT_NAME, PACKAGE_VERSION } from './package-info.mjs';

export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_VERSION = '2026-07-28';
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion', SERVER_KEY = 'io.modelcontextprotocol/serverInfo';
// JSON-RPC's own codes, and the one MCP 2026-07-28 reserves for a version it does not speak.
const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, NO_METHOD = -32601, BAD_PARAMS = -32602, INTERNAL = -32603, BAD_VERSION = -32022;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message, data) => Object.assign(new Error(message), { rpc: { code, message, ...(data === undefined ? {} : { data }) } });

/** A tool list from whatever a host has: a list of tools, or a table of operations (each then takes any object). */
export function describeTools(tools) {
  const list = Array.isArray(tools) ? tools : Object.entries(tools || {}).map(([name, value]) => isObject(value) && typeof value !== 'function' ? { name, ...value } : { name });
  const seen = new Set();
  return list.map(tool => {
    if (!isObject(tool) || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) throw new TypeError(`An MCP tool name is 1 to 128 of A-Z a-z 0-9 _ - . (got ${JSON.stringify(tool?.name)}).`);
    if (seen.has(tool.name)) throw new TypeError(`Two tools are called ${tool.name}.`);
    seen.add(tool.name);
    const schema = isObject(tool.inputSchema) ? tool.inputSchema : { type: 'object' };
    return { name: tool.name, ...(typeof tool.title === 'string' ? { title: tool.title } : {}), ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      inputSchema: schema, ...(isObject(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}), ...(isObject(tool.annotations) ? { annotations: tool.annotations } : {}) };
  });
}

/**
 * The server as a function of one message: for hosts with a transport of their own, and for tests.
 * @param {object} options
 * @param {object[]|object} options.tools [{ name, title?, description?, inputSchema?, outputSchema?, annotations? }], or a table
 *   whose keys are the tool names. A tool with no inputSchema takes any object.
 * @param {(name: string, args: object, context: {signal: AbortSignal}) => any} options.call runs a tool. What it returns is
 *   the result: text as it is, anything else as JSON (an object is also given as `structuredContent`). What it throws
 *   is a failed tool call (`isError`), with the error's message as its text: the agent reads it and can try again.
 * @param {string} [options.name] the server's name; default this package's
 * @param {string} [options.version]
 * @param {string} [options.title]
 * @param {string} [options.instructions] how to use the tools, offered to the agent at the start (older revisions only)
 * @returns {{handle: (message: any) => Promise<object|null>, tools: object[]}} `handle` resolves to the reply, or null for
 *   a notification and for a request that was cancelled
 */
export function createMcpServer({ tools, call, name = SHORT_NAME, version = PACKAGE_VERSION, title, instructions } = {}) {
  if (typeof call !== 'function') throw new TypeError('Give the MCP server a call(name, args) function.');
  const list = describeTools(tools), names = new Set(list.map(tool => tool.name));
  const serverInfo = { name, version, ...(title ? { title } : {}) };
  const running = new Map();   // request id -> AbortController

  async function answer(method, params, modern, id) {
    if (method === 'initialize') {
      // "If the server supports the requested protocol version, it MUST respond with the same version. Otherwise ... another protocol version it supports."
      const asked = params.protocolVersion;
      return { protocolVersion: MCP_LEGACY_VERSIONS.includes(asked) ? asked : MCP_LEGACY_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo, ...(instructions ? { instructions } : {}) };
    }
    if (method === 'ping') return {};
    if (method === 'server/discover') return { resultType: 'complete', supportedVersions: [MCP_VERSION], capabilities: { tools: {} }, ttlMs: 3600000, cacheScope: 'public', _meta: { [SERVER_KEY]: serverInfo } };
    if (method === 'tools/list') return { ...(modern ? { resultType: 'complete', ttlMs: 3600000, cacheScope: 'public' } : {}), tools: list };
    if (method === 'tools/call') {
      if (typeof params.name !== 'string' || !names.has(params.name)) throw failure(BAD_PARAMS, `Unknown tool: ${String(params.name).slice(0, 128)}`);
      if (params.arguments !== undefined && !isObject(params.arguments)) throw failure(BAD_PARAMS, 'Tool arguments are an object.');
      const controller = new AbortController();
      if (id !== undefined) running.set(id, controller);
      const done = modern ? { resultType: 'complete' } : {};
      try {
        const result = await call(params.name, params.arguments || {}, { signal: controller.signal });
        if (controller.signal.aborted) return null;
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? {});
        return { ...done, content: [{ type: 'text', text }], isError: false, ...(isObject(result) ? { structuredContent: result } : {}) };
      } catch (error) {
        if (controller.signal.aborted) return null;
        // A tool that failed is a result the agent can read, not a protocol error.
        return { ...done, content: [{ type: 'text', text: String(error?.message || 'The tool failed.').slice(0, 4000) }], isError: true };
      } finally { if (running.get(id) === controller) running.delete(id); }
    }
    throw failure(NO_METHOD, `Method not found: ${String(method).slice(0, 100)}`);
  }

  async function handle(message) {
    if (!isObject(message) || typeof message.method !== 'string') {
      // A reply to something we never asked, or not JSON-RPC at all.
      if (isObject(message) && message.method === undefined && (message.result !== undefined || message.error !== undefined)) return null;
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Not a JSON-RPC request.' } };
    }
    const { id, method } = message, params = isObject(message.params) ? message.params : {};
    if (id === undefined || id === null) {
      // Notifications get no reply. One of them withdraws a request in flight.
      if (method === 'notifications/cancelled') running.get(params.requestId)?.abort();
      return null;
    }
    if (typeof id !== 'string' && typeof id !== 'number') return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'A request id is a string or a number.' } };
    try {
      const named = isObject(params._meta) ? params._meta[VERSION_KEY] : undefined, modern = named !== undefined || method === 'server/discover';
      if (named !== undefined && named !== MCP_VERSION && method !== 'server/discover')
        throw failure(BAD_VERSION, 'Unsupported protocol version', { supported: [MCP_VERSION, ...MCP_LEGACY_VERSIONS], requested: named });
      const result = await answer(method, params, modern, id);
      return result === null ? null : { jsonrpc: '2.0', id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: error?.rpc || { code: INTERNAL, message: 'Internal error' } };
    }
  }
  return { handle, tools: list };
}

/**
 * Serves MCP on a pair of streams: one message per line in, one per line out, and nothing
 * else written to the output. Returns { done, close }: `done` resolves when the input ends
 * (the agent closed the connection) and every reply has been written.
 * @param {object} options as for createMcpServer, plus:
 * @param {object} [options.input] default process.stdin
 * @param {object} [options.output] default process.stdout
 * @param {(error: Error) => void} [options.onError] default: one line on stderr, which the protocol allows for logging
 */
export function serveMcp({ input = process.stdin, output = process.stdout, onError = error => process.stderr.write(`${String(error?.message || error)}\n`), ...options } = {}) {
  const server = createMcpServer(options);
  let open = true, busy = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const settle = () => { if (!open && !busy) finish(); };
  const write = reply => { if (reply) try { output.write(`${JSON.stringify(reply)}\n`); } catch (error) { onError(error); } };
  const reader = createLineReader(line => {
    let message;
    try { message = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }); }
    // Batches were dropped from the protocol (2025-06-18); each message is its own line.
    if (Array.isArray(message)) return write({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Send one message per line, not a batch.' } });
    busy++;
    server.handle(message).then(write, onError).finally(() => { busy--; settle(); });
  }, { maxLine: 8 << 20, onOversize: () => write({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'That message is too long.' } }) });
  const ended = () => { if (!open) return; open = false; reader.end(); settle(); };
  input.on('data', reader.push); input.on('end', ended); input.on('close', ended); input.on('error', ended);
  output.on?.('error', () => {});
  return { done, close: ended, tools: server.tools };
}

/**
 * The bridge: an MCP server on this process's stdio whose tools are a host's command
 * operations, reached over loopback with the session key the host left for its own CLI
 * (see ./commands.mjs). A host ships a script of a few lines that calls this, and names
 * that script as an MCP server in the agent's configuration.
 * @param {object} options
 * @param {string} options.app the host's name, as given to writeSession()
 * @param {string} options.name the session's name, for example `agent-4173`
 * @param {object[]|object} options.tools the operations to offer, as for createMcpServer. The names are the operation names.
 * @param {object} [options.defaults] fields added to the data of every call (the page an agent is working on, say);
 *   what the agent sends takes precedence
 * @param {string} [options.prefix] default '/agent/'
 * @param {string} [options.stateDir]
 * @param {number} [options.timeout] milliseconds for one call to the host; default 120000
 * @param {object} [options.server] { name, version, title, instructions } for the MCP side
 */
export function serveMcpBridge({ app, name, tools, defaults = {}, prefix, stateDir, timeout, server = {}, input, output, onError, fetch } = {}) {
  return serveMcp({ ...server, name: server.name || app, tools, input, output, onError,
    call: (operation, data) => callHost({ app, name, operation, data: { ...defaults, ...data }, ...(prefix ? { prefix } : {}), ...(stateDir ? { stateDir } : {}), ...(timeout ? { timeout } : {}), ...(fetch ? { fetch } : {}) }) });
}
