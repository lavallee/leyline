// The provider contract: what every adapter in this folder looks like to a host.
//
// A provider turns one request into one reply. While it works it may report what it is
// doing as a stream of normalised events. It knows nothing about documents, prompts or
// permissions: the host decides what to send, where the agent may write, and what to do
// with the reply.
//
//   provider.name            a short string: 'codex-app-server', 'cli-oneshot', 'http-chat'
//   provider.capabilities    { activity, textStream, sessions, cancel, shell, structuredOutput }
//   provider.run(request)    -> Promise<{ message, provenance, usage? }>
//   provider.cancel(key)     stop the run for that key, if one is in flight
//   provider.reset(key)      forget what the provider remembers for that key
//   provider.close()         release processes and sockets
//
// request, common to all adapters (each adapter documents its extras):
//   key           a host string naming the conversation. Providers with `sessions` keep
//                 their memory under it; a fresh key is a fresh agent.
//   input         a string, or a list of strings sent as separate parts of one message
//   instructions  standing instructions (a system prompt), where the provider has a place for them
//   onEvent       called with each ActivityEvent
//   onText        called as onText(piece, { segment }) with pieces of the reply as they arrive (only where
//                 `textStream`). `segment` counts the agent's messages within the turn: when it changes, a
//                 new message has begun and what came before was a note along the way.
//   signal        an AbortSignal; aborting rejects with a ProviderError whose code is 'stopped'
//   timeout       milliseconds
//
// ActivityEvent:
//   { id, kind: 'reasoning' | 'activity', status: 'running' | 'done' | 'failed' | 'stopped',
//     title?, text?, command?, paths? }
// plus two fields for streaming:
//   append?   text to add to the end of this item's text (a delta), instead of replacing it
//   output?   the tail of a finished command's output
// Events with the same id describe the same item as it changes; foldActivity() below
// keeps a list up to date from them.
//
// result:
//   message      the reply text
//   provenance   { provider, model, ... } for the host's records
//   usage        { inputTokens, outputTokens, ... } when the provider reports it

/** An error a provider raises on purpose. `code` is stable; `message` is for people. */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {'stopped'|'timeout'|'unavailable'|'auth'|'failed'|'busy'|'config'} code
   * @param {number} [status] an HTTP status a host may answer with
   */
  constructor(message, code = 'failed', status) {
    super(message); this.name = 'ProviderError'; this.code = code;
    this.status = status ?? { stopped: 499, timeout: 504, unavailable: 503, auth: 503, busy: 409, config: 500 }[code] ?? 502;
  }
}

export const ACTIVITY_KINDS = ['reasoning', 'activity'];
export const ACTIVITY_STATUSES = ['running', 'done', 'failed', 'stopped'];

/**
 * Folds one ActivityEvent into a list of activity items (the list a turn stores and the
 * shared ActivityLog component renders). Returns the item, or null when the list is full.
 * `describe` lets a host reword an event before it is stored: it receives the event and
 * the item and may return fields to assign (for example a friendlier title for a command).
 */
export function foldActivity(items, event, { max = 200, maxText = 20000, describe } = {}) {
  if (!event || typeof event.id !== 'string' && typeof event.id !== 'number') return null;
  let item = items.find(a => a.id === event.id);
  if (!item) {
    if (items.length >= max) return null;
    item = { id: event.id, kind: ACTIVITY_KINDS.includes(event.kind) ? event.kind : 'activity', text: '' };
    items.push(item);
  }
  if (event.append) item.text = (item.text + event.append).slice(-maxText);
  if (event.text !== undefined) item.text = String(event.text).slice(-maxText);
  if (event.command !== undefined) item.command = String(event.command).slice(0, 4000);
  if (Array.isArray(event.paths)) item.paths = event.paths.slice(0, 200).map(String);
  if (event.title) item.title = String(event.title).slice(0, 160);
  if (event.status && ACTIVITY_STATUSES.includes(event.status)) item.status = event.status;
  const extra = describe?.(event, item);
  if (extra && typeof extra === 'object') Object.assign(item, extra);
  if (event.output && !item.quiet) item.text = `${item.text}${item.text ? '\n\n' : ''}${event.output}`.slice(-maxText);
  return item;
}

/** Marks every item still running as finished: 'done' after success, 'stopped' otherwise. */
export function settleActivity(items, succeeded) {
  for (const item of items) if (item.status === 'running') item.status = succeeded ? 'done' : 'stopped';
}

/** Checks that an object has the shape of a provider. Throws a TypeError naming what is missing. */
export function assertProvider(provider) {
  for (const method of ['run', 'cancel', 'reset', 'close'])
    if (typeof provider?.[method] !== 'function') throw new TypeError(`A provider needs a ${method}() method.`);
  if (typeof provider.name !== 'string' || !provider.capabilities || typeof provider.capabilities !== 'object')
    throw new TypeError('A provider needs a name and a capabilities object.');
  return provider;
}

export const inputParts = input => (Array.isArray(input) ? input : [input]).filter(part => typeof part === 'string' && part.length);

/**
 * Gathers small pieces of streamed text into larger ones, so that a consumer sees a few
 * events a second instead of one per token. Pieces added under the same key are joined
 * and handed to that key's `deliver` together, after `ms` milliseconds or as soon as
 * `chars` characters are waiting. `flush()` hands over everything now: call it before
 * reporting anything that must come after the text already received.
 * @param {{ms?: number, chars?: number}} [options] default 40 ms and 400 characters; `ms: 0` passes every piece straight through
 */
export function createBatcher({ ms = 40, chars = 400 } = {}) {
  const held = new Map();
  let timer = null, size = 0;
  const flush = () => {
    clearTimeout(timer); timer = null; size = 0;
    for (const [key, entry] of [...held]) { held.delete(key); try { entry.deliver(entry.text); } catch { /* a consumer must not break the stream */ } }
  };
  return {
    add(key, text, deliver) {
      if (typeof text !== 'string' || !text) return;
      if (!(ms > 0)) { try { deliver(text); } catch { /* as above */ } return; }
      const entry = held.get(key);
      if (entry) entry.text += text; else held.set(key, { text, deliver });
      size += text.length;
      if (size >= chars) flush(); else if (!timer) { timer = setTimeout(flush, ms); timer.unref?.(); }
    },
    flush,
  };
}
