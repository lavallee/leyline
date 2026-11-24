// A conversation as a stream a browser can follow and pick up again: Server-Sent Events
// over a Node http response, fed by the conversation store's event log.
//
// What goes over the wire (https://html.spec.whatwg.org/multipage/server-sent-events.html):
//   retry: <ms>                                   once, at the start
//   event: snapshot                               the whole conversation; replaces what the client has
//   id: <cursor>
//   data: {"cursor","reason","conversation"}      reason: 'start' | 'gap' | 'lag'
//
//   id: <cursor>                                  one event (see ./events.mjs), to apply to the copy
//   data: {"seq","at","type",...}
//
//   : ping                                        a comment, when nothing else was sent for a while
//
// A client that reconnects sends the last id it saw in `Last-Event-ID` (EventSource does
// this by itself; the client in src/stream-client.mjs does too) and receives exactly the
// events after it. When that position is no longer held (it is older than the store keeps,
// or the server restarted) it receives a snapshot instead, with reason 'gap'.
//
// A slow client is never buffered for without bound: once more than `maxBuffered` bytes
// are waiting to be sent to it, events stop being queued; when it has caught up it gets a
// fresh snapshot, with reason 'lag'.
//
// This module does not decide who may read a conversation: the host checks the request
// before calling it.

/**
 * Serves one conversation on one response until the client goes away.
 * @param {object} store a conversation store (./conversations.mjs)
 * @param {string} key
 * @param {object} req a Node http IncomingMessage
 * @param {object} res a Node http ServerResponse, with nothing written yet
 * @param {object} [options]
 * @param {string} [options.after] the position to resume from; default the request's `Last-Event-ID` header
 * @param {number} [options.heartbeat] milliseconds of silence after which a comment line is sent; default 15000
 * @param {number} [options.maxBuffered] bytes that may wait unsent for this client; default 1,000,000. A
 *   snapshot is always sent whole, however large, and the bound is never below the response's own
 *   high-water mark (16 KB by default in Node), under which nothing counts as waiting.
 * @param {number} [options.retry] the reconnection delay suggested to the client, in milliseconds; default 1000
 * @param {object} [options.headers] extra response headers
 * @param {(conversation: object) => object} [options.shape] changes the conversation put in a snapshot (to leave
 *   out fields a browser should not see). It is not applied to events: a host that needs to hide a field
 *   must keep it off the turn.
 * @returns {{close: () => void, done: Promise<void>}} `done` resolves when the stream has ended, for any reason
 */
export function streamConversation(store, key, req, res, { after, heartbeat = 15000, maxBuffered = 1_000_000, retry = 1000, headers = {}, shape } = {}) {
  let over = false, stop = null, lagging = false, waiting = null, beat = null, quiet = true, round = 0, allowance = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const close = () => {
    if (over) return;
    over = true;
    stop?.(); stop = null;
    clearInterval(beat);
    req.off('close', close); res.off('close', close); res.off('error', close); res.off('drain', drained);
    if (!res.writableEnded && !res.destroyed) try { res.end(); } catch { /* the connection has gone */ }
    finish();
  };
  const write = text => { quiet = false; try { return res.write(text); } catch { close(); return false; } };

  // The whole conversation, then the events after it. If the client cannot take the
  // snapshot at once, the events wait until it has: they are still held by the store.
  async function begin(reason) {
    const mine = ++round;
    stop?.(); stop = null; waiting = null;
    const taken = await store.snapshot(key);
    if (over || mine !== round) return;                       // a later snapshot has taken over
    const conversation = shape ? shape(taken.conversation) : taken.conversation;
    const sent = write(`event: snapshot\nid: ${taken.cursor}\ndata: ${JSON.stringify({ cursor: taken.cursor, reason, conversation })}\n\n`);
    if (over) return;
    // A snapshot larger than the bound must not count against the events that follow it.
    allowance = sent ? 0 : res.writableLength;
    if (sent) follow(taken.cursor); else waiting = () => follow(taken.cursor);
  }
  function follow(position) {
    if (over) return;
    stop?.();
    stop = store.subscribe(key, { after: position, raw: true }, (line, at) => {
      if (over || lagging) return;
      if (at.closed) return close();
      if (at.gap) return void begin('gap').catch(close);
      // Only a write the response could not pass on at once can lead to a lag: that is also what promises a 'drain' later.
      const sent = write(`id: ${at.cursor}\ndata: ${line}\n\n`);
      if (!over && !sent && res.writableLength > maxBuffered + allowance) { lagging = true; stop?.(); stop = null; }
    });
    stop.ready.catch(close);
  }
  function drained() {
    if (over) return;
    allowance = 0;
    if (waiting) { const next = waiting; waiting = null; return next(); }
    if (lagging) { lagging = false; begin('lag').catch(close); }
  }

  req.on('close', close); res.on('close', close); res.on('error', close); res.on('drain', drained);
  (async () => {
    // Opening the conversation first means a conversation that cannot be read is an HTTP error, not a broken stream.
    try { await store.open(key); }
    catch (error) {
      if (!over && !res.headersSent) { const body = JSON.stringify({ error: String(error?.message || 'The conversation could not be opened.') }); res.writeHead(Number.isInteger(error?.status) ? error.status : 500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); }
      return close();
    }
    if (over) return;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive', ...headers });
    write(`retry: ${Math.max(0, Math.round(retry))}\n\n`);
    if (heartbeat > 0) { beat = setInterval(() => { if (quiet && !lagging && !waiting) write(': ping\n\n'); quiet = true; }, heartbeat); beat.unref?.(); }
    const header = req.headers?.['last-event-id'];
    const position = after ?? (typeof header === 'string' && header ? header : undefined);
    if (position === undefined) await begin('start'); else follow(position);
  })().catch(close);
  return { close, done };
}
