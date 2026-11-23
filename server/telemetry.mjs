// Optional telemetry. Nothing here runs unless a host asks for it.
//
// The hook: a host may pass `onCall(record)` to the conversation store (or call it
// itself) and receives one CallRecord per finished turn:
//
//   { key, lane, turnId, status: 'succeeded' | 'failed' | 'stopped',
//     startedAt, finishedAt, durationMs,          ISO times and milliseconds
//     provenance?: { provider, model, ... },      as the provider returned it
//     usage?: { inputTokens, outputTokens, cachedInputTokens?, reasoningOutputTokens? },
//     error?: string }
//
// The helper: createOtlpReporter({ url }) returns such a hook, which posts one span per
// turn as OTLP/HTTP JSON to the URL the host configures: an OpenTelemetry collector, or
// any service that accepts OTLP traces. With no URL it returns a function that does
// nothing. No prompt, reply or activity text is ever sent: only names, times, token
// counts and the status.
import { randomBytes } from 'node:crypto';

const nanos = iso => { const ms = Date.parse(iso); return Number.isFinite(ms) ? `${BigInt(ms) * 1000000n}` : '0'; };
const attribute = (key, value) => typeof value === 'number'
  ? { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }
  : { key, value: { stringValue: String(value) } };

/**
 * One CallRecord as an OTLP ExportTraceServiceRequest (JSON encoding), using the
 * OpenTelemetry GenAI attribute names. A provider that answers a single model call
 * ('http-chat') is reported as a `chat` span; an agent program is `invoke_agent`.
 */
export function otlpPayload(record, { serviceName = 'agent-chat', attributes = {}, operation } = {}) {
  const provider = record.provenance?.provider, model = record.provenance?.model;
  const kind = operation || (provider === 'http-chat' ? 'chat' : 'invoke_agent');
  const named = model && model !== 'provider default' ? model : undefined;
  const fields = {
    'gen_ai.operation.name': kind,
    'gen_ai.provider.name': provider,
    'gen_ai.agent.name': kind === 'invoke_agent' ? provider : undefined,
    'gen_ai.request.model': named,
    'gen_ai.conversation.id': record.key,
    'gen_ai.usage.input_tokens': record.usage?.inputTokens,
    'gen_ai.usage.output_tokens': record.usage?.outputTokens,
    'gen_ai.usage.cache_read.input_tokens': record.usage?.cachedInputTokens || undefined,
    'gen_ai.usage.reasoning.output_tokens': record.usage?.reasoningOutputTokens || undefined,
    'error.type': record.status === 'failed' ? 'error' : record.status === 'stopped' ? 'cancelled' : undefined,
    'agent_chat.turn.id': record.turnId,
    'agent_chat.turn.status': record.status,
    'agent_chat.lane': record.lane,
    ...attributes,
  };
  return { resourceSpans: [{
    resource: { attributes: [attribute('service.name', serviceName)] },
    scopeSpans: [{ scope: { name: '@lyra-forge/agent-chat' }, spans: [{
      traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'),
      name: [kind, kind === 'chat' ? named : provider].filter(Boolean).join(' '), kind: 3,
      startTimeUnixNano: nanos(record.startedAt), endTimeUnixNano: nanos(record.finishedAt),
      attributes: Object.entries(fields).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => attribute(key, value)),
      status: record.status === 'failed' ? { code: 2, ...(record.error ? { message: String(record.error).slice(0, 300) } : {}) } : { code: 1 },
    }] }],
  }] };
}

/**
 * @param {object} [options]
 * @param {string} [options.url] the full traces URL. Without it the reporter does nothing.
 * @param {string} [options.tokenEnv] the NAME of an environment variable holding a bearer token
 * @param {object} [options.headers] extra request headers
 * @param {string} [options.serviceName] default 'agent-chat'
 * @param {object} [options.attributes] extra span attributes on every span
 * @param {(record: object) => boolean} [options.filter] return false to skip a record
 * @param {number} [options.timeout] milliseconds; default 5000
 * @param {(error: Error) => void} [options.onError] default: ignore. Telemetry never fails a turn.
 * @returns {(record: object) => Promise<boolean>} resolves true when a span was accepted
 */
export function createOtlpReporter({ url, tokenEnv, headers = {}, serviceName, attributes, filter, timeout = 5000, onError = () => {},
  env = process.env, fetch: fetcher = globalThis.fetch } = {}) {
  if (!url) return async () => false;
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('The telemetry URL must be http or https.');
  if (tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new TypeError('tokenEnv is the name of an environment variable, not the token itself.');
  return async record => {
    try {
      if (filter && !filter(record)) return false;
      const token = tokenEnv ? env[tokenEnv] : undefined;
      const response = await fetcher(target, { method: 'POST', signal: AbortSignal.timeout(timeout),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: JSON.stringify(otlpPayload(record, { serviceName, attributes })) });
      if (!response.ok) throw new Error(`The telemetry endpoint answered ${response.status}.`);
      return true;
    } catch (error) { try { onError(error); } catch { /* nothing more to do */ } return false; }
  };
}
