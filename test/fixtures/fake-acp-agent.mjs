// A stand-in for an ACP agent in tests: JSON-RPC 2.0 on stdio, protocol version 1, no
// model. What it does with a prompt is chosen by words in the prompt's text. Everything
// it receives is appended to the file named by FAKE_LOG, one JSON value per line.
// FAKE_ACP is a JSON object of switches: { version, auth, authOk, load, resume, close,
// systemPrompt, additionalDirectories, mcpHttp }. FAKE_STORE names a file in which
// sessions outlive the process, so a second agent process can load them.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const opts = JSON.parse(process.env.FAKE_ACP || '{}');
const log = value => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + '\n'); };
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const stored = () => process.env.FAKE_STORE && existsSync(process.env.FAKE_STORE) ? JSON.parse(readFileSync(process.env.FAKE_STORE, 'utf8')) : {};
const store = (id, session) => { if (process.env.FAKE_STORE) writeFileSync(process.env.FAKE_STORE, JSON.stringify({ ...stored(), [id]: session })); };
const sessions = new Map();   // session id -> { turns, history }
const hanging = new Map();    // session id -> the id of the prompt request left open
const waiting = new Map();    // our request id -> resolve
let seq = 0, asked = 9000, authed = false;

// A request to the client; resolves to { result } or { error }.
const ask = (method, params) => new Promise(resolve => { const id = ++asked; waiting.set(id, resolve); send({ id, method, params }); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const said = text => ({ type: 'text', text });

log({ env: { hasSecret: 'FAKE_SECRET' in process.env }, cwd: process.cwd() });
const lines = readline.createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', async line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params } = message;
  if (method === undefined) { waiting.get(id)?.(message); waiting.delete(id); return; }
  const update = (sessionId, fields) => send({ method: 'session/update', params: { sessionId, update: fields } });

  if (method === 'initialize') return send({ id, result: { protocolVersion: opts.version ?? 1,
    agentCapabilities: { loadSession: !!opts.load, promptCapabilities: {}, mcpCapabilities: { http: !!opts.mcpHttp, sse: false },
      sessionCapabilities: { ...(opts.resume ? { resume: {} } : {}), ...(opts.close ? { close: {} } : {}), ...(opts.systemPrompt ? { systemPrompt: {} } : {}),
        ...(opts.additionalDirectories ? { additionalDirectories: {} } : {}) } },
    agentInfo: { name: 'fake-agent', title: 'Fake Agent', version: '0.0.1' },
    authMethods: opts.auth ? [{ id: 'fake-login', name: 'Fake login' }, { id: 'fake-terminal', name: 'Log in from the terminal', type: 'terminal', args: ['--login'] }] : [] } });
  if (method === 'authenticate') {
    if (params.methodId === 'fake-login' && opts.authOk) { authed = true; return send({ id, result: {} }); }
    return send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'A browser is needed to sign in.' } } });
  }
  if (method === 'session/new') {
    if (opts.auth && !authed) return send({ id, error: { code: -32000, message: 'Authentication required' } });
    const sessionId = `s${++seq}-${process.pid}`;
    sessions.set(sessionId, { turns: 0, history: [] }); store(sessionId, sessions.get(sessionId));
    return send({ id, result: { sessionId, models: { currentModelId: 'fake-model', availableModels: [] } } });
  }
  if (method === 'session/load' || method === 'session/resume') {
    const saved = stored()[params.sessionId];
    if (!saved) return send({ id, error: { code: -32002, message: 'Resource not found', data: { sessionId: params.sessionId } } });
    sessions.set(params.sessionId, saved);
    if (method === 'session/load') for (const [mine, theirs] of saved.history) {
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: said(mine) });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: said(`REPLAYED ${theirs}`) });
    }
    return send({ id, result: {} });
  }
  if (method === 'session/close') { sessions.delete(params.sessionId); return send({ id, result: {} }); }
  if (method === 'session/cancel') {
    const open = hanging.get(params.sessionId);
    if (open !== undefined) { hanging.delete(params.sessionId); send({ id: open, result: { stopReason: 'cancelled' } }); }
    return;
  }
  if (method !== 'session/prompt') return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });

  const sessionId = params.sessionId, state = sessions.get(sessionId);
  if (!state) return send({ id, error: { code: -32002, message: 'Resource not found', data: { sessionId } } });
  const text = params.prompt.map(part => part.text).join(' | ');
  const note = fields => update(sessionId, fields);
  const finish = reply => {
    state.turns++; state.history.push([text, reply]); store(sessionId, state);
    note({ sessionUpdate: 'agent_message_chunk', messageId: `m${state.turns}`, content: said(reply) });
    send({ id, result: { stopReason: 'end_turn' } });
  };
  const outcome = answer => answer.error ? `refused ${answer.error.code}: ${answer.error.message}` : JSON.stringify(answer.result);

  if (text.includes('deaf')) return;                                  // never answers, even when cancelled
  if (text.includes('hang')) return void hanging.set(sessionId, id);
  if (text.includes('die')) return process.exit(1);
  if (text.includes('fail')) return send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'The model is unavailable.' } } });
  if (text.includes('refuse')) return send({ id, result: { stopReason: 'refusal' } });
  if (text.includes('slow')) {
    for (let n = 0; n < 6; n++) { note({ sessionUpdate: 'agent_message_chunk', messageId: 'slow', content: said(`${n} `) }); await pause(50); }
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (text.includes('garbage')) {
    process.stdout.write('Loaded cached credentials.\n');
    process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId"\n');
    process.stdout.write('[1,2,3]\n\n"just a string"\n{"neither":"a request nor a reply"}\n');
    return finish('still here');
  }
  const readfile = text.match(/readfile (\S+)(?: (\d+) (\d+))?/);
  if (readfile) return finish(`read: ${outcome(await ask('fs/read_text_file', { sessionId, path: readfile[1],
    ...(readfile[2] ? { line: Number(readfile[2]), limit: Number(readfile[3]) } : {}) }))}`);
  const writefile = text.match(/writefile (\S+) "([^"]*)" "([^"]*)"/);
  if (writefile) {
    const before = await ask('fs/read_text_file', { sessionId, path: writefile[1] });
    if (before.error) return finish(`read ${outcome(before)}`);
    const after = before.result.content.replace(writefile[2], writefile[3]);
    const wrote = await ask('fs/write_text_file', { sessionId, path: writefile[1], content: after });
    return finish(wrote.error ? `write ${outcome(wrote)}` : 'written');
  }
  const permission = text.match(/permission (\w+) (\S+)/);
  if (permission) {
    note({ sessionUpdate: 'tool_call', toolCallId: 'p1', title: `Touching ${permission[2]}`, kind: permission[1], status: 'pending', locations: [{ path: permission[2] }] });
    const answer = await ask('session/request_permission', { sessionId,
      toolCall: { toolCallId: 'p1', content: permission[1] === 'edit' ? [{ type: 'diff', path: permission[2], oldText: 'one\n', newText: 'two\n' }] : [] },
      options: text.includes('no-reject') ? [{ optionId: 'yes-always', name: 'Always', kind: 'allow_always' }]
        : [{ optionId: 'yes-always', name: 'Always', kind: 'allow_always' }, { optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
    if (answer.result?.outcome?.outcome === 'cancelled') return send({ id, result: { stopReason: 'cancelled' } });
    return finish(`permission: ${outcome(answer)}`);
  }
  if (text.includes('terminal')) {
    const made = await ask('terminal/create', { sessionId, command: 'echo', args: ['hi'] });
    if (made.error) return finish(`terminal ${outcome(made)}`);
    const exit = await ask('terminal/wait_for_exit', { sessionId, terminalId: made.result.terminalId });
    const output = await ask('terminal/output', { sessionId, terminalId: made.result.terminalId });
    await ask('terminal/kill', { sessionId, terminalId: made.result.terminalId });
    await ask('terminal/release', { sessionId, terminalId: made.result.terminalId });
    return finish(`terminal: ${outcome(exit)} ${outcome(output)}`);
  }
  if (text.includes('unknown-method')) return finish(`asked: ${outcome(await ask('editor/open', { sessionId }))}`);
  if (text.includes('strange-session')) return finish(`asked: ${outcome(await ask('fs/read_text_file', { sessionId: 'not-yours', path: '/etc/hostname' }))}`);

  // The ordinary turn: thoughts, a plan, a note, tool calls of several kinds, then the reply.
  note({ sessionUpdate: 'agent_thought_chunk', content: said('Reading') });
  note({ sessionUpdate: 'agent_thought_chunk', content: said(' the text.') });
  note({ sessionUpdate: 'plan', entries: [{ content: 'Look around', priority: 'high', status: 'completed' }, { content: 'Change the date', priority: 'medium', status: 'in_progress' },
    { content: 'Check', priority: 'low', status: 'pending' }] });
  note({ sessionUpdate: 'agent_message_chunk', messageId: 'early', content: said('Looking ') });
  note({ sessionUpdate: 'agent_message_chunk', messageId: 'early', content: said('around first.') });
  note({ sessionUpdate: 'agent_message_chunk', messageId: 'early', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } });
  note({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Reading notes/a.md', name: 'read_file', kind: 'read', status: 'pending', locations: [{ path: '/work/notes/a.md', line: 3 }] });
  note({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' });
  note({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: said('12 lines') }] });
  note({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'ls notes', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls notes' } });
  note({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed', content: [{ type: 'content', content: said('ls: no such folder') }] });
  note({ sessionUpdate: 'agent_thought_chunk', content: said('Now the edit.') });
  note({ sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'Editing notes/a.md', kind: 'edit', status: 'pending',
    content: [{ type: 'diff', path: '/work/notes/a.md', oldText: 'We meet in March.\n', newText: 'We meet in April.\n' }] });
  note({ sessionUpdate: 'tool_call_update', toolCallId: 'c3', status: 'in_progress' });
  note({ sessionUpdate: 'tool_call_update', toolCallId: 'c3', status: 'completed' });
  note({ sessionUpdate: 'tool_call', toolCallId: 'c4', title: '', status: 'completed', content: [{ type: 'diff', path: '/work/notes/new.md', newText: 'A new file.\n' }, { type: 'terminal', terminalId: 't9' }] });
  note({ sessionUpdate: 'available_commands_update', availableCommands: [] });
  note({ sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
  note({ sessionUpdate: 'plan', entries: [{ content: 'Look around', priority: 'high', status: 'completed' }, { content: 'Change the date', priority: 'medium', status: 'completed' },
    { content: 'Check', priority: 'low', status: 'completed' }] });
  finish(`turn ${state.turns + 1}: ${text}`);
});
