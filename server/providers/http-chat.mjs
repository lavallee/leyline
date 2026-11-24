// A model reached over HTTP, speaking either the OpenAI Chat Completions wire
// (`POST {baseUrl}/chat/completions`) or the Anthropic Messages wire
// (`POST {baseUrl}/messages`). It needs no vendor program on the machine, so it is the
// way to use other models: a hosted API, a local server, or a routing proxy in front of
// several. Text in, text out; no tools. The model can therefore read only what the host
// puts in the messages and can change nothing.
//
// The API key is read from the environment variable the host names (`apiKeyEnv`) at the
// moment of each request. It is never stored on the provider or put in provenance.
import { ProviderError, inputParts } from './contract.mjs';

const WIRES = ['openai', 'anthropic'];

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_DELAY = 30000;
const tooLarge = () => new ProviderError('The model sent more than this provider accepts.', 'failed');

/**
 * Splits a fetch Response body into server-sent events: yields { event, data } with data as text.
 * Lines may end in LF, CRLF or CR, and the bytes may be split anywhere, including inside a
 * character or between a CR and its LF. Comments and fields other than `event` and `data`
 * are skipped. An event whose text passes `maxEvent` characters is refused with a
 * ProviderError rather than held in memory.
 */
export async function* sseEvents(body, { maxEvent = Infinity } = {}) {
  const decoder = new TextDecoder();
  let held = [], heldSize = 0;        // a line still arriving
  let event = 'message', data = null, size = 0, afterCR = false;
  const out = [];
  const line = text => {
    if (!text) { if (data) out.push({ event, data: data.join('\n') }); event = 'message'; data = null; size = 0; return; }
    if (text.startsWith('data:')) { (data ||= []).push(text.charCodeAt(5) === 32 ? text.slice(6) : text.slice(5)); size += text.length; }
    else if (text.startsWith('event:')) event = text.slice(6).trim();
  };
  const feed = text => {
    let from = 0;
    if (afterCR) { afterCR = false; if (text.charCodeAt(0) === 10) from = 1; }
    let lf = text.indexOf('\n', from), cr = text.indexOf('\r', from);
    while (lf >= 0 || cr >= 0) {
      const at = cr >= 0 && (lf < 0 || cr < lf) ? cr : lf;
      const piece = text.slice(from, at);
      if (heldSize) { held.push(piece); line(held.join('')); held = []; heldSize = 0; } else line(piece);
      from = at + 1;
      if (at === cr) {
        if (from === text.length) afterCR = true;
        else if (text.charCodeAt(from) === 10) from++;
        cr = text.indexOf('\r', from);
        if (lf >= 0 && lf < from) lf = text.indexOf('\n', from);
      } else lf = text.indexOf('\n', from);
    }
    if (from < text.length) { const rest = from ? text.slice(from) : text; held.push(rest); heldSize += rest.length; }
    if (size + heldSize > maxEvent) throw tooLarge();
  };
  for await (const chunk of body) {
    feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    if (out.length) yield* out.splice(0);
  }
  feed(decoder.decode());
  // A last event with no blank line after it is still passed on, as it always was.
  if (heldSize) { line(held.join('')); held = []; heldSize = 0; }
  line('');
  if (out.length) yield* out.splice(0);
}

// The text of a response body, refused once it passes `limit` bytes.
async function bodyText(response, limit) {
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') { const text = await response.text(); if (text.length > limit) throw tooLarge(); return text; }
  const decoder = new TextDecoder(); let text = '', bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw tooLarge(); text += decoder.decode(chunk, { stream: true }); }
  return text + decoder.decode();
}

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('') : '';

export class HttpChatProvider {
  name = 'http-chat';
  capabilities = { activity: false, textStream: true, sessions: true, cancel: true, shell: false, structuredOutput: false };

  /**
   * @param {object} options
   * @param {string} options.baseUrl up to and including the version segment, such as
   *   `https://api.openai.com/v1`, `https://api.anthropic.com/v1` or `http://127.0.0.1:11434/v1`
   * @param {'openai'|'anthropic'} [options.wire] default 'openai'
   * @param {string} options.model
   * @param {string} [options.apiKeyEnv] the NAME of the environment variable holding the key.
   *   Leave it out for servers that need none.
   * @param {'bearer'|'x-api-key'} [options.auth] how the key is sent. Default: bearer for the
   *   OpenAI wire, x-api-key for the Anthropic wire. A proxy may want bearer on both.
   * @param {object} [options.headers] extra request headers
   * @param {boolean} [options.stream] default true
   * @param {number} [options.maxTokens] default 16000 (required by the Anthropic wire; sent on the OpenAI wire only when set)
   * @param {string} [options.anthropicVersion] default '2026-10-21'
   * @param {boolean} [options.includeUsage] ask an OpenAI-wire stream for token counts; default true
   * @param {object} [options.body] extra fields merged into the request body
   * @param {number} [options.maxHistory] messages kept per key; default 40
   * @param {number} [options.maxResponse] characters of reply accepted (and of any one stream event); default 16,000,000.
   *   A larger answer is refused with code 'failed' while it arrives.
   * @param {number} [options.idleTimeout] milliseconds without a byte from the endpoint (before the first one, and
   *   between chunks) after which the request is stopped with code 'timeout'. Default: none, only the run's `timeout`.
   * @param {number} [options.retries] how many times a request is sent again when the endpoint could not be
   *   reached or answered 408, 429 or 5xx before any part of an answer arrived. Default 0. The wait doubles
   *   from `retryDelay` (default 500 ms, with jitter) or follows the endpoint's Retry-After, up to 30 s.
   *   The request is a POST and is sent again whole: an endpoint that failed after doing the work may bill it twice.
   * @param {number} [options.retryDelay]
   * @param {number} [options.maxKeys] conversations remembered (see run); the least recently used is forgotten
   *   past this. Default 1000
   * @param {object} [options.env] where apiKeyEnv is looked up; default process.env
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ baseUrl, wire = 'openai', model, apiKeyEnv, auth, headers = {}, stream = true, maxTokens, anthropicVersion = '2026-10-21',
    includeUsage = true, body = {}, maxHistory = 40, maxResponse = 16_000_000, idleTimeout, retries = 0, retryDelay = 500, maxKeys = 1000,
    env = process.env, fetch: fetcher = globalThis.fetch } = {}) {
    if (!WIRES.includes(wire)) throw new ProviderError(`Unknown wire "${wire}". Use "openai" or "anthropic".`, 'config');
    let url; try { url = new URL(baseUrl); } catch { throw new ProviderError('Give the provider a base URL.', 'config'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new ProviderError('The base URL must be http or https.', 'config');
    if (typeof model !== 'string' || !model) throw new ProviderError('Give the provider a model name.', 'config');
    if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new ProviderError('apiKeyEnv is the name of an environment variable, not the key itself.', 'config');
    Object.assign(this, { wire, model, apiKeyEnv, auth: auth || (wire === 'anthropic' ? 'x-api-key' : 'bearer'), headers, stream, maxTokens,
      anthropicVersion, includeUsage, body, maxHistory, maxResponse, idleTimeout, retries, retryDelay, maxKeys, env, fetch: fetcher });
    this.endpoint = baseUrl.replace(/\/+$/, '') + (wire === 'anthropic' ? '/messages' : '/chat/completions');
    this.origin = url.origin;
    this.histories = new Map();    // key -> [{ role, content }]
    this.controllers = new Map();  // key -> a function that stops the run
  }

  request(messages, instructions, { model, maxTokens, stream }) {
    const headers = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', ...this.headers };
    if (this.apiKeyEnv) {
      const secret = this.env[this.apiKeyEnv];
      if (!secret) throw new ProviderError(`The environment variable ${this.apiKeyEnv} is not set.`, 'auth');
      if (this.auth === 'x-api-key') headers['x-api-key'] = secret; else headers.authorization = `Bearer ${secret}`;
    }
    let body;
    if (this.wire === 'anthropic') {
      headers['anthropic-version'] = this.anthropicVersion;
      body = { model, max_tokens: maxTokens ?? 16000, ...(instructions ? { system: instructions } : {}), messages, ...this.body, ...(stream ? { stream: true } : {}) };
    } else {
      body = { model, messages: [...(instructions ? [{ role: 'system', content: instructions }] : []), ...messages],
        ...(maxTokens ? { max_tokens: maxTokens } : {}), ...this.body,
        ...(stream ? { stream: true, ...(this.includeUsage ? { stream_options: { include_usage: true } } : {}) } : {}) };
    }
    return { headers, body: JSON.stringify(body) };
  }

  /**
   * Two ways to say what to send:
   * - `messages`: the whole exchange, `[{ role: 'user' | 'assistant', content }]`. Nothing is remembered.
   * - `input` with a `key`: the provider keeps the exchange for that key in memory and adds
   *   to it, so the conversation continues. reset(key) forgets it.
   * `instructions` is the system prompt. `onText(piece)` receives the reply as it streams.
   * Extras: `model`, `maxTokens`, `stream` override the provider's settings for one run.
   */
  async run({ key, input, messages, instructions, onText, signal, timeout = 300000, model = this.model, maxTokens = this.maxTokens, stream = this.stream } = {}) {
    let history = null, sent;
    if (Array.isArray(messages)) {
      sent = messages.filter(m => m && ['user', 'assistant'].includes(m.role) && (typeof m.content === 'string' || Array.isArray(m.content)));
      if (!sent.length) throw new ProviderError('Give the run at least one message.', 'config');
    } else {
      const text = inputParts(input).join('\n\n');
      if (!text) throw new ProviderError('Give the run some input.', 'config');
      history = key !== undefined ? this.histories.get(key) || [] : [];
      sent = [...history, { role: 'user', content: text }];
    }
    if (signal?.aborted) throw new ProviderError('Stopped.', 'stopped');
    if (key !== undefined && this.controllers.has(key)) throw new ProviderError('That conversation already has a request running.', 'busy');
    const controller = new AbortController();
    let why = null, idle = null;
    const stop = () => { why ||= 'stopped'; controller.abort(); };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { why ||= 'timeout'; controller.abort(); }, Math.min(Math.max(0, Number(timeout) || 0), 2 ** 31 - 1));
    // Heard from the endpoint: the quiet period starts again.
    const heard = () => { if (!(this.idleTimeout > 0)) return; clearTimeout(idle); idle = setTimeout(() => { why ||= 'timeout'; controller.abort(); }, this.idleTimeout); };
    const listening = async function* (chunks) { for await (const chunk of chunks) { heard(); yield chunk; } };
    if (key !== undefined) this.controllers.set(key, stop);
    // Secrets this request carries, so that nothing an endpoint echoes back reaches an error message.
    const secrets = [this.apiKeyEnv ? this.env[this.apiKeyEnv] : null, ...Object.values(this.headers || {})].filter(value => typeof value === 'string' && value.length >= 8);
    const scrub = text => secrets.reduce((clean, secret) => clean.split(secret).join('[redacted]'), String(text));
    try {
      const { headers, body } = this.request(sent, instructions, { model, maxTokens, stream });
      let response;
      for (let attempt = 0; ; attempt++) {
        let unreachable = null;
        heard();
        try { response = await this.fetch(this.endpoint, { method: 'POST', headers, body, signal: controller.signal }); }
        catch (error) { if (why) throw error; unreachable = error; response = null; }
        if (response?.ok) break;
        const failure = response ? await this.failure(response)
          : new ProviderError(`The model could not be reached: ${String(unreachable?.cause?.message || unreachable?.message || unreachable).slice(0, 300)}`, 'unavailable');
        if (attempt >= this.retries || (response && !RETRY_STATUS.has(response.status))) throw failure;
        // Nothing of an answer has arrived, so sending the request again cannot duplicate one.
        clearTimeout(idle);
        const asked = Number(response?.headers?.get?.('retry-after'));
        const wait = Number.isFinite(asked) && asked >= 0 && response?.headers?.get?.('retry-after') !== null ? asked * 1000 : this.retryDelay * 2 ** attempt * (0.75 + Math.random() / 2);
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(pause); controller.signal.removeEventListener('abort', done); controller.signal.aborted ? reject(new Error('aborted')) : resolve(); };
          const pause = setTimeout(done, Math.min(MAX_DELAY, Math.max(0, wait)));
          controller.signal.addEventListener('abort', done, { once: true });
          if (controller.signal.aborted) done();
        });
      }
      heard();
      let result;
      if (stream && /event-stream/i.test(response.headers.get('content-type') || '')) result = await this.readStream(listening(response.body), onText);
      else {
        let parsed;
        const text = await bodyText({ body: response.body && typeof response.body[Symbol.asyncIterator] === 'function' ? listening(response.body) : null, text: () => response.text() }, this.maxResponse * 4);
        try { parsed = JSON.parse(text); } catch { throw new ProviderError('The model’s answer was not in the expected form.', 'failed'); }
        result = this.readWhole(parsed, onText);
      }
      if (result.refused) throw new ProviderError('The model declined this request.', 'failed');
      if (history && key !== undefined) {
        const next = [...sent, { role: 'assistant', content: result.message }];
        // Keep the tail, starting on a user message as both wires expect.
        let from = Math.max(0, next.length - this.maxHistory);
        while (from < next.length && next[from].role !== 'user') from++;
        this.histories.delete(key); this.histories.set(key, next.slice(from));
        // The conversations remembered are bounded too: the one used longest ago goes first.
        while (this.histories.size > this.maxKeys) this.histories.delete(this.histories.keys().next().value);
      }
      return { message: result.message, provenance: { provider: this.name, wire: this.wire, model: result.model || model, endpoint: this.origin,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}) }, ...(result.usage ? { usage: result.usage } : {}) };
    } catch (error) {
      if (why === 'stopped') throw new ProviderError('Stopped.', 'stopped');
      if (why === 'timeout') throw new ProviderError('The model took too long and was stopped.', 'timeout');
      if (error instanceof ProviderError) { error.message = scrub(error.message); throw error; }
      throw new ProviderError(scrub(`The model could not be reached: ${String(error?.cause?.message || error?.message || error).slice(0, 300)}`), 'unavailable');
    } finally {
      clearTimeout(timer); clearTimeout(idle); signal?.removeEventListener('abort', stop);
      if (key !== undefined && this.controllers.get(key) === stop) this.controllers.delete(key);
    }
  }

  async failure(response) {
    let detail = '';
    try { const text = await bodyText(response, 1_000_000); const data = JSON.parse(text); detail = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || ''; } catch { /* no JSON body */ }
    const auth = response.status === 401 || response.status === 403;
    return new ProviderError(`The model endpoint answered ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : '.'}`, auth ? 'auth' : response.status === 429 || response.status >= 500 ? 'unavailable' : 'failed');
  }

  readWhole(data, onText) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProviderError('The model’s answer was not in the expected form.', 'failed');
    let message, usage, stopReason;
    if (this.wire === 'anthropic') {
      message = textOf(data.content); stopReason = data.stop_reason;
      if (data.usage) usage = { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 };
    } else {
      const choice = data.choices?.[0];
      message = textOf(choice?.message?.content); stopReason = choice?.finish_reason;
      if (data.usage) usage = { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 };
    }
    if (typeof message !== 'string' || (!message && !stopReason)) throw new ProviderError('The model’s answer was not in the expected form.', 'failed');
    if (message.length > this.maxResponse) throw tooLarge();
    if (message) try { onText?.(message); } catch { /* a host's handler must not break the run */ }
    return { message, usage, stopReason, model: data.model, refused: stopReason === 'refusal' };
  }

  async readStream(body, onText) {
    let message = '', model, stopReason, input, output, seen = false, finished = false;
    const piece = text => { if (!text) return; message += text; if (message.length > this.maxResponse) throw tooLarge(); try { onText?.(text); } catch { /* as above */ } };
    for await (const { event, data } of sseEvents(body, { maxEvent: this.maxResponse })) {
      if (data === '[DONE]') { finished = true; break; }
      let json; try { json = JSON.parse(data); } catch { continue; }
      if (!json || typeof json !== 'object') continue;
      seen = true;
      if (event === 'error' || json.type === 'error' || (json.error && !json.choices)) throw new ProviderError(`The model stopped with an error: ${String(json.error?.message || json.message || 'unknown').slice(0, 300)}`, 'failed');
      if (this.wire === 'anthropic') {
        if (json.type === 'message_start') { model = json.message?.model; input = json.message?.usage?.input_tokens ?? input; output = json.message?.usage?.output_tokens ?? output; }
        else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') piece(json.delta.text);
        else if (json.type === 'message_stop') finished = true;
        else if (json.type === 'message_delta') { stopReason = json.delta?.stop_reason ?? stopReason; input = json.usage?.input_tokens ?? input; output = json.usage?.output_tokens ?? output; }
      } else {
        model = json.model || model;
        const choice = json.choices?.[0];
        if (typeof choice?.delta?.content === 'string') piece(choice.delta.content);
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        if (json.usage) { input = json.usage.prompt_tokens ?? input; output = json.usage.completion_tokens ?? output; }
      }
    }
    if (!seen) throw new ProviderError('The model’s answer was not in the expected form.', 'failed');
    // A stream that simply stops, with no finish reason and no end marker, lost its connection part-way.
    if (!finished && !stopReason) throw new ProviderError('The model’s answer was cut off before it finished.', 'unavailable');
    const usage = input !== undefined || output !== undefined ? { inputTokens: input ?? 0, outputTokens: output ?? 0 } : undefined;
    return { message, usage, stopReason, model, refused: stopReason === 'refusal' };
  }

  cancel(key) { const stop = this.controllers.get(key); stop?.(); return !!stop; }
  reset(key) { this.histories.delete(key); }
  close() { for (const stop of [...this.controllers.values()]) stop(); this.controllers.clear(); this.histories.clear(); }
}
