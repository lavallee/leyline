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

/** Splits a fetch Response body into server-sent events: yields { event, data } with data as text. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = block => {
    let event = 'message'; const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n?/g, '\n');
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const parsed = parse(buffer.slice(0, at)); buffer = buffer.slice(at + 2);
      if (parsed) yield parsed;
    }
  }
  const parsed = parse(buffer + decoder.decode());
  if (parsed) yield parsed;
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
   * @param {object} [options.env] where apiKeyEnv is looked up; default process.env
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ baseUrl, wire = 'openai', model, apiKeyEnv, auth, headers = {}, stream = true, maxTokens, anthropicVersion = '2026-10-21',
    includeUsage = true, body = {}, maxHistory = 40, env = process.env, fetch: fetcher = globalThis.fetch } = {}) {
    if (!WIRES.includes(wire)) throw new ProviderError(`Unknown wire "${wire}". Use "openai" or "anthropic".`, 'config');
    let url; try { url = new URL(baseUrl); } catch { throw new ProviderError('Give the provider a base URL.', 'config'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new ProviderError('The base URL must be http or https.', 'config');
    if (typeof model !== 'string' || !model) throw new ProviderError('Give the provider a model name.', 'config');
    if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new ProviderError('apiKeyEnv is the name of an environment variable, not the key itself.', 'config');
    Object.assign(this, { wire, model, apiKeyEnv, auth: auth || (wire === 'anthropic' ? 'x-api-key' : 'bearer'), headers, stream, maxTokens,
      anthropicVersion, includeUsage, body, maxHistory, env, fetch: fetcher });
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
    let why = null;
    const stop = () => { why ||= 'stopped'; controller.abort(); };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { why ||= 'timeout'; controller.abort(); }, timeout);
    if (key !== undefined) this.controllers.set(key, stop);
    try {
      const { headers, body } = this.request(sent, instructions, { model, maxTokens, stream });
      const response = await this.fetch(this.endpoint, { method: 'POST', headers, body, signal: controller.signal });
      if (!response.ok) throw await this.failure(response);
      const result = stream && /event-stream/i.test(response.headers.get('content-type') || '')
        ? await this.readStream(response.body, onText) : this.readWhole(await response.json(), onText);
      if (result.refused) throw new ProviderError('The model declined this request.', 'failed');
      if (history && key !== undefined) {
        const next = [...sent, { role: 'assistant', content: result.message }];
        // Keep the tail, starting on a user message as both wires expect.
        let from = Math.max(0, next.length - this.maxHistory);
        while (from < next.length && next[from].role !== 'user') from++;
        this.histories.set(key, next.slice(from));
      }
      return { message: result.message, provenance: { provider: this.name, wire: this.wire, model: result.model || model, endpoint: this.origin,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}) }, ...(result.usage ? { usage: result.usage } : {}) };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (why === 'stopped') throw new ProviderError('Stopped.', 'stopped');
      if (why === 'timeout') throw new ProviderError('The model took too long and was stopped.', 'timeout');
      throw new ProviderError(`The model could not be reached: ${String(error?.cause?.message || error?.message || error).slice(0, 300)}`, 'unavailable');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (key !== undefined && this.controllers.get(key) === stop) this.controllers.delete(key);
    }
  }

  async failure(response) {
    let detail = '';
    try { const text = await response.text(); const data = JSON.parse(text); detail = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || ''; } catch { /* no JSON body */ }
    const auth = response.status === 401 || response.status === 403;
    return new ProviderError(`The model endpoint answered ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : '.'}`, auth ? 'auth' : response.status === 429 || response.status >= 500 ? 'unavailable' : 'failed');
  }

  readWhole(data, onText) {
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
    if (message) try { onText?.(message); } catch { /* a host's handler must not break the run */ }
    return { message, usage, stopReason, model: data.model, refused: stopReason === 'refusal' };
  }

  async readStream(body, onText) {
    let message = '', model, stopReason, input, output, seen = false;
    const piece = text => { if (!text) return; message += text; try { onText?.(text); } catch { /* as above */ } };
    for await (const { event, data } of sseEvents(body)) {
      if (data === '[DONE]') break;
      let json; try { json = JSON.parse(data); } catch { continue; }
      seen = true;
      if (event === 'error' || json.type === 'error' || (json.error && !json.choices)) throw new ProviderError(`The model stopped with an error: ${String(json.error?.message || json.message || 'unknown').slice(0, 300)}`, 'failed');
      if (this.wire === 'anthropic') {
        if (json.type === 'message_start') { model = json.message?.model; input = json.message?.usage?.input_tokens ?? input; output = json.message?.usage?.output_tokens ?? output; }
        else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') piece(json.delta.text);
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
    const usage = input !== undefined || output !== undefined ? { inputTokens: input ?? 0, outputTokens: output ?? 0 } : undefined;
    return { message, usage, stopReason, model, refused: stopReason === 'refusal' };
  }

  cancel(key) { const stop = this.controllers.get(key); stop?.(); return !!stop; }
  reset(key) { this.histories.delete(key); }
  close() { for (const stop of [...this.controllers.values()]) stop(); this.controllers.clear(); this.histories.clear(); }
}
