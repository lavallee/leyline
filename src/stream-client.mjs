// Keeps a copy of a conversation up to date from the server's event stream (the helper in
// server/stream.mjs). Plain JavaScript with no dependencies and no React: it needs only
// `fetch` with a readable body, which every current browser and Node 22 have.
//
// It reconnects by itself, waiting longer after each failure, and resumes from the last
// event it applied (the `Last-Event-ID` header), so a dropped connection or a reload of
// the server costs nothing but the wait. When the server no longer holds that position it
// sends the whole conversation again, and the copy is replaced.
import { applyEvent } from '../server/events.mjs';

/**
 * @param {string} url the host's stream endpoint for one conversation
 * @param {object} [options]
 * @param {(conversation: object, event: object|null) => void} [options.onChange] after every change to the copy;
 *   `event` is the event that made it, or null when the whole copy was replaced
 * @param {(event: object) => void} [options.onEvent] each event, after it has been applied
 * @param {(reason: string) => void} [options.onGap] the copy was replaced because events were missed: 'gap' (the
 *   position was no longer held), 'lag' (this client was too slow) or 'mismatch' (an event did not fit the copy)
 * @param {(status: 'connecting'|'open'|'waiting'|'closed', detail?: object) => void} [options.onStatus]
 * @param {object} [options.headers] extra request headers
 * @param {string} [options.credentials] passed to fetch; default 'same-origin'
 * @param {number} [options.minDelay] milliseconds before the first reconnection; default 500
 * @param {number} [options.maxDelay] the longest wait between attempts; default 15000
 * @param {number} [options.silence] milliseconds without a byte from the server after which the connection is
 *   taken for dead and replaced; default 45000 (three of the server's heartbeats). 0 turns the check off.
 * @param {Function} [options.fetch] default globalThis.fetch
 * @returns {{state: object|null, cursor: string|null, close: () => void, reconnect: () => void}}
 */
export function followConversation(url, { onChange, onEvent, onGap, onStatus, headers = {}, credentials = 'same-origin', minDelay = 500, maxDelay = 15000, silence = 45000,
  fetch: fetcher = globalThis.fetch } = {}) {
  let state = null, cursor = null, closed = false, controller = null, failures = 0, wake = null, watchdog = null;
  const call = (fn, ...args) => { try { fn?.(...args); } catch { /* a listener must not break the stream */ } };

  function take(type, id, data) {
    let value; try { value = JSON.parse(data); } catch { return; }
    if (!value || typeof value !== 'object') return;
    if (type === 'snapshot') {
      if (!value.conversation || !Array.isArray(value.conversation.turns)) return;
      const replaced = state !== null && value.reason !== 'start';
      state = value.conversation; cursor = id || value.cursor || null;
      if (replaced) call(onGap, value.reason);
      return call(onChange, state, null);
    }
    if (type !== 'message' || state === null) return;
    if (!applyEvent(state, value)) {
      // The copy is out of step with the server: ask for all of it again.
      cursor = null; state = null; call(onGap, 'mismatch');
      return controller?.abort();
    }
    if (id) cursor = id;
    call(onEvent, value); call(onChange, state, value);
  }

  // The event stream format: fields on lines, an event at each blank line.
  function parser() {
    let buffer = '', type = 'message', id = null, data = [];
    return text => {
      buffer += text;
      let at;
      while ((at = buffer.search(/\r\n|\n|\r(?!$)/)) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + (buffer.startsWith('\r\n', at) ? 2 : 1));
        if (line === '') { if (data.length) take(type, id, data.join('\n')); type = 'message'; data = []; id = null; continue; }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value); else if (field === 'event') type = value || 'message'; else if (field === 'id' && !value.includes('\0')) id = value;
      }
    };
  }

  async function once() {
    controller = new AbortController();
    const heard = () => { if (!(silence > 0)) return; clearTimeout(watchdog); watchdog = setTimeout(() => controller?.abort(), silence); };
    heard();
    const response = await fetcher(url, { headers: { accept: 'text/event-stream', ...(cursor ? { 'last-event-id': cursor } : {}), ...headers }, credentials, cache: 'no-store', signal: controller.signal });
    if (!response.ok || !response.body) { try { await response.body?.cancel(); } catch { /* nothing to cancel */ } throw Object.assign(new Error(`The stream answered ${response.status}.`), { status: response.status }); }
    call(onStatus, 'open');
    const reader = response.body.getReader(), decoder = new TextDecoder(), feed = parser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        heard(); failures = 0;
        feed(decoder.decode(value, { stream: true }));
      }
    } finally { try { await reader.cancel(); } catch { /* already closed */ } }
  }

  (async () => {
    while (!closed) {
      call(onStatus, 'connecting');
      let problem = null;
      try { await once(); } catch (error) { problem = error; }
      clearTimeout(watchdog);
      if (closed) break;
      // Each failure in a row doubles the wait, up to the cap, with some spread so that many
      // clients do not all return at the same moment. A connection that delivered anything counts as a success.
      const delay = Math.min(maxDelay, minDelay * 2 ** Math.min(failures, 16)) * (0.5 + Math.random() / 2);
      failures++;
      call(onStatus, 'waiting', { delay, error: problem });
      await new Promise(resolve => { const timer = setTimeout(resolve, delay); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = null;
    }
    call(onStatus, 'closed');
  })();

  return {
    get state() { return state; },
    get cursor() { return cursor; },
    /** Drops the connection and makes a new one at once, resuming where this one stopped. */
    reconnect() { failures = 0; controller?.abort(); wake?.(); },
    close() { closed = true; clearTimeout(watchdog); controller?.abort(); wake?.(); },
  };
}
