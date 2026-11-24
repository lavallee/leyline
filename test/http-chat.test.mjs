import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpChatProvider, sseEvents } from '../server/providers/http-chat.mjs';

// A local server standing in for a model endpoint. `reply(req, body, res)` decides the answer.
async function endpoint(t, reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', d => { text += d; });
    req.on('end', () => { const body = JSON.parse(text || '{}'); seen.push({ method: req.method, url: req.url, headers: req.headers, body }); reply(req, body, res); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, base: `http://127.0.0.1:${server.address().port}/v1` };
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(e); res.end(); };
const data = value => `data: ${JSON.stringify(value)}\n\n`;
const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;

test('OpenAI wire, streamed: pieces arrive through onText, usage and model are reported', async t => {
  const { seen, base } = await endpoint(t, (req, body, res) => sse(res, [
    data({ model: 'served-model', choices: [{ delta: { role: 'assistant' } }] }),
    data({ model: 'served-model', choices: [{ delta: { content: 'Hel' } }] }),
    ': keep-alive comment\n\n',
    data({ model: 'served-model', choices: [{ delta: { content: 'lo.' }, finish_reason: 'stop' }] }),
    data({ model: 'served-model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    'data: [DONE]\n\n']));
  const provider = new HttpChatProvider({ baseUrl: base + '/', model: 'asked-model', apiKeyEnv: 'FAKE_KEY', env: { FAKE_KEY: 'sk-test' }, headers: { 'X-Extra': 'yes' } });
  const pieces = [];
  const result = await provider.run({ instructions: 'Be kind.', input: 'Say hello', onText: piece => pieces.push(piece) });
  assert.equal(result.message, 'Hello.');
  assert.deepEqual(pieces, ['Hel', 'lo.']);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  assert.deepEqual(result.provenance, { provider: 'http-chat', wire: 'openai', model: 'served-model', endpoint: new URL(base).origin, stopReason: 'stop' });
  assert.ok(!JSON.stringify(result).includes('sk-test'), 'the key is not in the result');
  const [call] = seen;
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer sk-test');
  assert.equal(call.headers['x-extra'], 'yes');
  assert.deepEqual(call.body, { model: 'asked-model', messages: [{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'Say hello' }],
    stream: true, stream_options: { include_usage: true } });
});

test('OpenAI wire, whole: stream off, no key needed, extra body fields merged', async t => {
  const { seen, base } = await endpoint(t, (req, body, res) => json(res, { model: 'm', choices: [{ message: { role: 'assistant', content: 'Whole answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  const provider = new HttpChatProvider({ baseUrl: base, model: 'local', stream: false, maxTokens: 500, body: { reasoning_effort: 'low' }, includeUsage: false });
  const pieces = [];
  const result = await provider.run({ messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Yes?' }, { role: 'user', content: 'Go on' }, { role: 'tool', content: 'dropped' }], onText: p => pieces.push(p) });
  assert.equal(result.message, 'Whole answer.');
  assert.deepEqual(pieces, ['Whole answer.']);
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2 });
  assert.equal(seen[0].headers.authorization, undefined);
  assert.deepEqual(seen[0].body, { model: 'local', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Yes?' }, { role: 'user', content: 'Go on' }], max_tokens: 500, reasoning_effort: 'low' });
});

test('Anthropic wire, streamed: system prompt, version header, x-api-key, usage from both ends', async t => {
  const { seen, base } = await endpoint(t, (req, body, res) => sse(res, [
    event('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'served', usage: { input_tokens: 20, output_tokens: 1 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } }),
    event('ping', { type: 'ping' }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Bon' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'jour' } }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
    event('message_stop', { type: 'message_stop' })]));
  const provider = new HttpChatProvider({ baseUrl: base, wire: 'anthropic', model: 'claude-opus-5-5', apiKeyEnv: 'FAKE_KEY', env: { FAKE_KEY: 'sk-ant-test' } });
  const result = await provider.run({ instructions: 'Reply in French.', input: 'Hello' });
  assert.equal(result.message, 'Bonjour', 'thinking is not part of the reply');
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 9 });
  assert.equal(result.provenance.model, 'served');
  assert.equal(result.provenance.stopReason, 'end_turn');
  const [call] = seen;
  assert.equal(call.url, '/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.headers['anthropic-version'], '2026-10-21');
  assert.deepEqual(call.body, { model: 'claude-opus-5-5', max_tokens: 16000, system: 'Reply in French.', messages: [{ role: 'user', content: 'Hello' }], stream: true });
  assert.ok(!('temperature' in call.body), 'no sampling parameters are sent');
});

test('Anthropic wire, whole, through a proxy that wants a bearer token and its own headers', async t => {
  const { seen, base } = await endpoint(t, (req, body, res) => json(res, { model: 'routed/model', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Routed.' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 } }));
  const provider = new HttpChatProvider({ baseUrl: base, wire: 'anthropic', model: 'somm/auto', apiKeyEnv: 'PROXY_TOKEN', auth: 'bearer', env: { PROXY_TOKEN: 'tok' },
    stream: false, headers: { 'X-Somm-Workload': 'copycat-chat' }, anthropicVersion: '2023-06-01' });
  const result = await provider.run({ input: 'x', maxTokens: 64 });
  assert.equal(result.message, 'Routed.');
  assert.equal(result.provenance.model, 'routed/model');
  assert.equal(seen[0].headers.authorization, 'Bearer tok');
  assert.equal(seen[0].headers['x-api-key'], undefined);
  assert.equal(seen[0].headers['x-somm-workload'], 'copycat-chat');
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].body.model, 'somm/auto');
  assert.equal(seen[0].body.max_tokens, 64);
  assert.equal(seen[0].body.stream, undefined);
});

test('a key keeps the conversation in memory; reset forgets it; history is trimmed on a user turn', async t => {
  let n = 0;
  const { seen, base } = await endpoint(t, (req, body, res) => json(res, { choices: [{ message: { content: `answer ${++n}` }, finish_reason: 'stop' }] }));
  const provider = new HttpChatProvider({ baseUrl: base, model: 'm', stream: false, maxHistory: 4 });
  await provider.run({ key: 'doc:main', input: 'one' });
  await provider.run({ key: 'doc:main', input: 'two' });
  await provider.run({ key: 'doc:side', input: 'elsewhere' });
  assert.deepEqual(seen[1].body.messages, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'two' }]);
  assert.deepEqual(seen[2].body.messages, [{ role: 'user', content: 'elsewhere' }], 'another key is another conversation');
  await provider.run({ key: 'doc:main', input: 'three' });
  await provider.run({ key: 'doc:main', input: 'four' });
  assert.deepEqual(seen[4].body.messages.map(m => m.content), ['two', 'answer 2', 'three', 'answer 4', 'four']);
  assert.equal(seen[4].body.messages[0].role, 'user');
  provider.reset('doc:main');
  await provider.run({ key: 'doc:main', input: 'fresh' });
  assert.deepEqual(seen[5].body.messages, [{ role: 'user', content: 'fresh' }]);
});

test('errors: status codes, in-stream errors, refusals, a missing key, an unreachable host', async t => {
  const { base } = await endpoint(t, (req, body, res) => {
    const ask = body.messages.at(-1).content;
    if (ask === '401') return json(res, { error: { message: 'bad key' } }, 401);
    if (ask === '429') return json(res, { error: { message: 'slow down' } }, 429);
    if (ask === '400') return json(res, { error: { message: 'unknown model' } }, 400);
    if (ask === 'midstream') return sse(res, [event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } }), event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]);
    if (ask === 'refuse') return json(res, { content: [], stop_reason: 'refusal' });
    if (ask === 'garbage') return json(res, { unexpected: true });
    if (ask === 'empty-stream') return sse(res, []);
    json(res, {});
  });
  const provider = new HttpChatProvider({ baseUrl: base, wire: 'anthropic', model: 'm', apiKeyEnv: 'K', env: { K: 'secret-value' } });
  await assert.rejects(provider.run({ input: '401' }), error => error.code === 'auth' && /401: bad key/.test(error.message) && !error.message.includes('secret-value'));
  await assert.rejects(provider.run({ input: '429' }), { code: 'unavailable' });
  await assert.rejects(provider.run({ input: '400' }), { code: 'failed', message: /unknown model/ });
  await assert.rejects(provider.run({ input: 'midstream' }), { code: 'failed', message: /Overloaded/ });
  await assert.rejects(provider.run({ input: 'refuse' }), { code: 'failed', message: /declined/ });
  await assert.rejects(provider.run({ input: 'garbage' }), { code: 'failed', message: /expected form/ });
  await assert.rejects(provider.run({ input: 'empty-stream' }), { code: 'failed' });
  await assert.rejects(provider.run({ input: '' }), { code: 'config' });
  await assert.rejects(provider.run({ messages: [] }), { code: 'config' });
  await assert.rejects(new HttpChatProvider({ baseUrl: base, model: 'm', apiKeyEnv: 'UNSET_VARIABLE', env: {} }).run({ input: 'x' }), { code: 'auth', message: /UNSET_VARIABLE is not set/ });
  await assert.rejects(new HttpChatProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }).run({ input: 'x' }), { code: 'unavailable' });
  assert.throws(() => new HttpChatProvider({ baseUrl: 'ftp://x/v1', model: 'm' }), { code: 'config' });
  assert.throws(() => new HttpChatProvider({ baseUrl: base }), { code: 'config' });
  assert.throws(() => new HttpChatProvider({ baseUrl: base, model: 'm', wire: 'gemini' }), { code: 'config' });
  assert.throws(() => new HttpChatProvider({ baseUrl: base, model: 'm', apiKeyEnv: 'sk-live-looks-like-a-key' }), { code: 'config', message: /name of an environment variable/ });
});

test('abort, cancel and timeout stop a request that is waiting on the model', async t => {
  const { seen, base } = await endpoint(t, (req, body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(data({ choices: [{ delta: { content: 'begun' } }] })); /* never ends */ });
  const provider = new HttpChatProvider({ baseUrl: base, model: 'm' });
  const controller = new AbortController();
  const pieces = [];
  const aborted = provider.run({ input: 'x', signal: controller.signal, onText: p => { pieces.push(p); controller.abort(); } });
  await assert.rejects(aborted, { code: 'stopped' });
  assert.deepEqual(pieces, ['begun']);
  const keyed = provider.run({ key: 'k', input: 'x', onText: () => provider.cancel('k') });
  await assert.rejects(provider.run({ key: 'k', input: 'y' }), { code: 'busy' });
  await assert.rejects(keyed, { code: 'stopped' });
  assert.equal(provider.cancel('k'), false);
  await assert.rejects(provider.run({ input: 'x', timeout: 80 }), { code: 'timeout' });
  await assert.rejects(provider.run({ input: 'x', signal: AbortSignal.abort() }), { code: 'stopped' });
  await provider.run({ key: 'k', input: 'again', timeout: 80 }).catch(() => {});
  assert.deepEqual(seen.at(-1).body.messages, [{ role: 'user', content: 'again' }], 'a stopped exchange is not remembered');
});

test('sseEvents handles split chunks, CRLF and multi-line data', async () => {
  const encoder = new TextEncoder();
  async function* chunks() { for (const part of ['event: a\r\nda', 'ta: one\r\n\r\ndata: two\ndata: three\n', '\ndata: last']) yield encoder.encode(part); }
  const out = []; for await (const e of sseEvents(chunks())) out.push(e);
  assert.deepEqual(out, [{ event: 'a', data: 'one' }, { event: 'message', data: 'two\nthree' }, { event: 'message', data: 'last' }]);
});

// ---------------------------------------------------------------- hardening

const random = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const collect = async (iterable, options) => { const out = []; for await (const e of sseEvents(iterable, options)) out.push(e); return out; };
async function* pieces(bytes, cuts) { let from = 0; for (const cut of [...cuts, bytes.length]) { if (cut > from) yield bytes.subarray(from, cut); from = Math.max(from, cut); } }

test('sseEvents: a CR and its LF in different chunks are one line ending', async () => {
  const encoder = new TextEncoder();
  async function* chunks() { for (const part of ['event: a\r', '\ndata: one\r', '\ndata: two\r\n\r', '\nevent: b\r\ndata: three\r\n\r\n']) yield encoder.encode(part); }
  assert.deepEqual(await collect(chunks()), [{ event: 'a', data: 'one\ntwo' }, { event: 'b', data: 'three' }]);
});

test('sseEvents: the events are the same however the bytes are split', async () => {
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
    const next = random(seed), pick = list => list[Math.floor(next() * list.length)], expected = [];
    let text = '';
    for (let i = 0; i < 120; i++) {
      const eol = pick(['\n', '\n', '\r\n', '\r']);
      if (next() < 0.15) { text += `: comment ${i}${eol}${eol}`; continue; }
      const name = next() < 0.4 ? pick(['delta', 'ping', 'error']) : null;
      const lines = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(['plain', '{"text":"naïve café"}', '日本語 🙂', '', ' leading space', 'x'.repeat(Math.floor(next() * 400))]));
      if (name) text += `event: ${name}${eol}`;
      for (const line of lines) text += `data:${next() < 0.8 ? ' ' : line.startsWith(' ') ? ' ' : ''}${line}${eol}`;
      if (next() < 0.2) text += `id: ${i}${eol}retry: 100${eol}`;
      text += eol;
      expected.push({ event: name || 'message', data: lines.join('\n') });
    }
    const bytes = new TextEncoder().encode(text);
    for (let round = 0; round < 12; round++) {
      const cuts = Array.from({ length: Math.floor(next() * (round < 2 ? 2000 : 40)) }, () => Math.floor(next() * bytes.length)).sort((a, b) => a - b);
      assert.deepEqual(await collect(pieces(bytes, cuts)), expected, `seed ${seed}, round ${round}`);
    }
  }
});

test('sseEvents: an event larger than the cap is refused, not held in memory', async () => {
  const encoder = new TextEncoder();
  async function* endless() { yield encoder.encode('data: '); for (let i = 0; i < 1000; i++) yield encoder.encode('x'.repeat(1000)); }
  await assert.rejects(collect(endless(), { maxEvent: 50000 }), { code: 'failed' });
});

test('a stream that ends before the model finished is an error, not a short answer', async t => {
  const { base } = await endpoint(t, (req, body, res) => body.max_tokens
    ? sse(res, [event('message_start', { type: 'message_start', message: { model: 'm' } }), event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Half an ans' } })])
    : sse(res, [data({ choices: [{ delta: { content: 'Half an ans' } }] })]));
  for (const wire of ['openai', 'anthropic']) {
    const provider = new HttpChatProvider({ baseUrl: base, wire, model: 'm' });
    await assert.rejects(provider.run({ key: 'k', input: 'x' }), error => error.code === 'unavailable' && /cut off/.test(error.message), wire);
    assert.equal(provider.histories.has('k'), false, 'half an answer is not remembered');
  }
});

test('answers that are not what the wire promises are failures with a code, never a crash', async t => {
  const { base } = await endpoint(t, (req, body, res) => {
    const ask = body.messages.at(-1).content;
    if (ask === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>gateway says hello</html>'); }
    if (ask === 'null') return json(res, null);
    if (ask === 'list') return json(res, [1, 2]);
    if (ask === 'odd-stream') return sse(res, ['data: null\n\n', 'data: 7\n\n', 'data: "text"\n\n', data({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']);
    json(res, {});
  });
  const whole = new HttpChatProvider({ baseUrl: base, model: 'm', stream: false });
  for (const ask of ['html', 'null', 'list']) await assert.rejects(whole.run({ input: ask }), error => error.code === 'failed' && /expected form/.test(error.message), ask);
  assert.equal((await new HttpChatProvider({ baseUrl: base, model: 'm' }).run({ input: 'odd-stream' })).message, 'ok');
});

test('the key never appears in an error, even when the endpoint echoes it', async t => {
  const key = 'sk-live-0123456789abcdef', token = 'proxy-token-abcdef123456';
  const { base } = await endpoint(t, (req, body, res) => {
    const ask = body.messages.at(-1).content;
    if (ask === 'status') return json(res, { error: { message: `Incorrect API key provided: ${req.headers.authorization}; also ${req.headers['x-proxy']}` } }, 401);
    sse(res, [data({ error: { message: `upstream rejected ${key}` } })]);
  });
  const provider = new HttpChatProvider({ baseUrl: base, model: 'm', apiKeyEnv: 'K', env: { K: key }, headers: { 'x-proxy': token } });
  for (const ask of ['status', 'stream']) await assert.rejects(provider.run({ input: ask }), error => {
    assert.ok(!error.message.includes(key) && !error.message.includes(token), `${ask}: ${error.message}`);
    return error.name === 'ProviderError';
  });
});

test('an answer larger than the provider accepts is refused while it arrives', async t => {
  const { base } = await endpoint(t, (req, body, res) => {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write(data({ choices: [{ delta: { content: 'x'.repeat(5000) } }] })), 1);
      res.on('close', () => clearInterval(timer));
    } else json(res, { choices: [{ message: { content: 'y'.repeat(500000) }, finish_reason: 'stop' }] });
  });
  const began = Date.now();
  await assert.rejects(new HttpChatProvider({ baseUrl: base, model: 'm', maxResponse: 40000 }).run({ input: 'x', timeout: 20000 }), { code: 'failed', message: /more than/ });
  await assert.rejects(new HttpChatProvider({ baseUrl: base, model: 'm', maxResponse: 40000, stream: false }).run({ input: 'x', timeout: 20000 }), { code: 'failed', message: /more than/ });
  assert.ok(Date.now() - began < 5000);
});

test('idleTimeout: a stream that goes quiet is stopped long before the overall timeout', async t => {
  const { base } = await endpoint(t, (req, body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(data({ choices: [{ delta: { content: 'begun' } }] })); });
  const began = Date.now();
  await assert.rejects(new HttpChatProvider({ baseUrl: base, model: 'm', idleTimeout: 120 }).run({ input: 'x', timeout: 30000 }), { code: 'timeout' });
  assert.ok(Date.now() - began < 3000);
});

test('retries: off by default; when asked, only before any answer has arrived, and a stop ends the wait', async t => {
  let calls = 0, plan = [];
  const { base } = await endpoint(t, (req, body, res) => {
    const step = plan[calls++] ?? 'ok';
    if (step === 'ok') return json(res, { choices: [{ message: { content: `answer after ${calls} calls` }, finish_reason: 'stop' }] });
    if (step === 'midstream') return sse(res, [data({ choices: [{ delta: { content: 'par' } }] }), data({ error: { message: 'overloaded' } })]);
    if (step === 'drop') return req.socket.destroy();
    res.writeHead(step, { 'content-type': 'application/json', ...(step === 429 ? { 'retry-after': '0' } : {}) }); res.end(JSON.stringify({ error: { message: `status ${step}` } }));
  });
  const make = options => new HttpChatProvider({ baseUrl: base, model: 'm', stream: false, retryDelay: 5, ...options });
  const reset = steps => { calls = 0; plan = steps; };
  reset([503]); await assert.rejects(make().run({ input: 'x' }), { code: 'unavailable' }); assert.equal(calls, 1, 'no retry unless asked');
  reset([503, 429, 'drop']); assert.equal((await make({ retries: 3 }).run({ input: 'x' })).message, 'answer after 4 calls');
  reset([503, 503, 503]); await assert.rejects(make({ retries: 2 }).run({ input: 'x' }), { code: 'unavailable' }); assert.equal(calls, 3, 'gives up after the retries');
  reset([400]); await assert.rejects(make({ retries: 3 }).run({ input: 'x' }), { code: 'failed' }); assert.equal(calls, 1, 'a refusal of the request itself is not retried');
  reset([401]); await assert.rejects(make({ retries: 3 }).run({ input: 'x' }), { code: 'auth' }); assert.equal(calls, 1);
  reset(['midstream']); await assert.rejects(make({ retries: 3, stream: true }).run({ input: 'x' }), { code: 'failed' }); assert.equal(calls, 1, 'never once part of an answer has arrived');
  reset([503, 503, 503, 503]);
  const controller = new AbortController(), began = Date.now();
  const waiting = make({ retries: 3, retryDelay: 60000 }).run({ input: 'x', signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(waiting, { code: 'stopped' });
  assert.ok(Date.now() - began < 3000 && calls === 1);
});
