import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createOtlpReporter, otlpPayload } from '../server/telemetry.mjs';
import { ATTRIBUTE_PREFIX, SHORT_NAME } from '../server/package-info.mjs';

const record = { key: 'doc-1', lane: 'doc-1:main', turnId: 'turn-1', status: 'succeeded', startedAt: '2026-11-23T10:00:00.000Z', finishedAt: '2026-11-23T10:00:02.500Z',
  durationMs: 2500, provenance: { provider: 'codex-app-server', model: 'gpt-x', threadId: 't1' }, usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, reasoningOutputTokens: 8 } };
const attrs = span => Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue ?? Number(a.value.intValue ?? a.value.doubleValue)]));
const spanOf = payload => payload.resourceSpans[0].scopeSpans[0].spans[0];

async function collector(t, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => { let text = ''; req.on('data', d => { text += d; }); req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: JSON.parse(text) }); res.writeHead(status).end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${server.address().port}/api/otlp/v1/traces` };
}

test('off by default: with no URL the reporter does nothing', async () => {
  let called = false;
  const report = createOtlpReporter({ fetch: () => { called = true; } });
  assert.equal(await report(record), false);
  assert.equal(await createOtlpReporter()(record), false);
  assert.equal(called, false);
});

test('an agent turn becomes one invoke_agent span with GenAI attributes and no content', () => {
  const payload = otlpPayload({ ...record, message: 'THE REPLY', user: 'THE REQUEST' }, { serviceName: 'copycat', attributes: { 'somm.workload': 'page-chat' } });
  assert.deepEqual(payload.resourceSpans[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'copycat' } }]);
  const span = spanOf(payload);
  assert.match(span.traceId, /^[0-9a-f]{32}$/); assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.equal(span.name, 'invoke_agent codex-app-server');
  assert.equal(span.kind, 3);
  assert.equal(span.startTimeUnixNano, '1795428000000000000');
  assert.equal(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano), 2500000000n);
  assert.deepEqual(span.status, { code: 1 });
  assert.deepEqual(attrs(span), { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'codex-app-server', 'gen_ai.agent.name': 'codex-app-server', 'gen_ai.request.model': 'gpt-x',
    'gen_ai.conversation.id': 'doc-1', 'gen_ai.usage.input_tokens': 120, 'gen_ai.usage.output_tokens': 30, 'gen_ai.usage.reasoning.output_tokens': 8,
    [`${ATTRIBUTE_PREFIX}.turn.id`]: 'turn-1', [`${ATTRIBUTE_PREFIX}.turn.status`]: 'succeeded', [`${ATTRIBUTE_PREFIX}.lane`]: 'doc-1:main', 'somm.workload': 'page-chat' });
  assert.ok(!JSON.stringify(payload).includes('THE RE'), 'no request or reply text is exported');
  assert.equal(span.attributes.find(a => a.key === 'gen_ai.usage.input_tokens').value.intValue, '120', 'integers use the OTLP JSON string form');
});

test('a single model call is a chat span; failures and stops are marked', () => {
  const chat = spanOf(otlpPayload({ ...record, provenance: { provider: 'http-chat', model: 'claude-opus-5-5' }, usage: undefined }));
  assert.equal(chat.name, 'chat claude-opus-5-5');
  assert.equal(attrs(chat)['gen_ai.agent.name'], undefined);
  assert.equal(attrs(chat)['gen_ai.usage.input_tokens'], undefined);
  const failed = spanOf(otlpPayload({ ...record, status: 'failed', error: 'The model is unavailable.', provenance: { provider: 'cli-oneshot', model: 'provider default' } }));
  assert.deepEqual(failed.status, { code: 2, message: 'The model is unavailable.' });
  assert.equal(attrs(failed)['error.type'], 'error');
  assert.equal(attrs(failed)['gen_ai.request.model'], undefined, 'an unknown model is left out, not invented');
  assert.equal(attrs(spanOf(otlpPayload({ ...record, status: 'stopped' })))['error.type'], 'cancelled');
  assert.equal(spanOf(otlpPayload({ key: 'k', status: 'succeeded' })).name, 'invoke_agent');
});

test('the reporter posts JSON with a bearer token read from the named variable', async t => {
  const { seen, url } = await collector(t);
  const report = createOtlpReporter({ url, tokenEnv: 'TELEMETRY_TOKEN', env: { TELEMETRY_TOKEN: 'tok-123' }, serviceName: 'skein', headers: { 'X-Somm-Project': 'writing' },
    filter: r => r.status !== 'stopped' });
  assert.equal(await report(record), true);
  assert.equal(await report({ ...record, status: 'stopped' }), false, 'filtered out');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/otlp/v1/traces');
  assert.equal(seen[0].headers.authorization, 'Bearer tok-123');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].headers['x-somm-project'], 'writing');
  assert.equal(seen[0].headers['content-encoding'], undefined, 'the body is not compressed');
  assert.equal(spanOf(seen[0].body).name, 'invoke_agent codex-app-server');
  assert.equal(seen[0].body.resourceSpans[0].resource.attributes[0].value.stringValue, 'skein');
});

test('telemetry never throws: a refusing or unreachable endpoint is reported to onError only', async t => {
  const { url } = await collector(t, 401), errors = [];
  assert.equal(await createOtlpReporter({ url, onError: e => errors.push(e.message) })(record), false);
  assert.equal(await createOtlpReporter({ url: 'http://127.0.0.1:1/v1/traces', onError: e => errors.push('unreachable') })(record), false);
  assert.equal(await createOtlpReporter({ url, onError: () => { throw new Error('handler broke'); } })(record), false);
  assert.deepEqual(errors, ['The telemetry endpoint answered 401.', 'unreachable']);
  assert.throws(() => createOtlpReporter({ url: 'file:///tmp/x' }), TypeError);
  assert.throws(() => createOtlpReporter({ url, tokenEnv: 'not a name' }), TypeError);
});
