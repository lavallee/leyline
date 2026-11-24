# Changelog

## 0.8.0 (unreleased)

The shell: the strip, side panel, routines and history that every one of our tools shows,
moved here so none of them keeps its own copy (`docs/shell.md`).

- `./app-bar`: `AppBar` (product, title, live dot, tag, status, actions), `AppBarButton`
  (icon and a label that hides below 1024px, `pressed`, `count`, `attention`, `collapse`)
  and `AppBarMore` (collapsed actions under one button on a phone).
- `./side-panel`: `SidePanel`, the one panel at a time on the right, with `PanelNotice`
  and `PanelError`. `placement="page"` fixes it below the strip over a page.
- `./history-panel`: `HistoryPanel`, generalised from Toucan's History, over the rows
  `./server/history` lists. A version is shown by `Preview` or by the host (`onPreview`).
- `./routine-menu`: Toucan's richer menu folded in: groups by kind, search, a host's own
  running routine on the trigger, and "From your work" suggestions. `onAskAgent` may now
  be passed the text to draft. Existing props are unchanged; the trigger is an
  `AppBarButton`, and `container` defaults to the strip's.

## 0.7.0 (2026-11-24)

The plumbing `docs/landscape.md` found missing: a conversation is now a log of events a
browser can subscribe to and resume, the reply streams, an agent's question can wait for
a person, a running turn can be steered, and the agent's memory survives a restart. The
command table can also be offered as an MCP server. No export path or signature was
removed; every new behaviour is opt-in except where listed below.

Behaviour changes (what a host could notice without opting in to anything):

- `./server/conversations`: **what is on disk changed.** Beside each `<name>.json` there
  is now `<name>.events.jsonl`, and `<name>.json` is a snapshot that can be behind until
  the log is next folded into it (every 1,000 events, on `reset()` and on `close()`). A
  program that reads `<name>.json` itself while the host is running sees an older state:
  use `readConversation(dir, key)`. Files written by earlier versions are read as they
  are. An earlier version of this package pointed at the folder reads the snapshots
  only; after a clean `close()` those hold everything.
- `./server/conversations`: a change a host makes to a turn **without** `tools.save()`,
  `store.save(key)` or `store.update()` used to reach the disk with the next write of
  that conversation, whatever caused it. It now reaches the disk at the next compaction
  or `close()`. Copycat's own calls (`tools.save()` in a run, `store.save(key)` after a
  command) are unaffected.
- `./server/conversations`: `store.save(key)` with nothing changed writes nothing. Before,
  it rewrote the file.
- `./server/conversations`: the snapshot carries `eventSeq`, and a conversation gains a
  `memory` field once a turn on its main lane succeeds with a `threadId` or `sessionId`
  in its `provenance`. `unload()` refuses a conversation that has subscribers.
- `./server/providers/codex-app-server`: **requests from the agent are answered by
  method.** Before, every request got `{ decision: 'decline' }`, which is the wrong
  shape for all but two of them. Now `item/permissions/requestApproval` is declined as
  `{ permissions: {}, scope: 'turn' }`, `item/tool/requestUserInput` as
  `{ answers: {} }`, `mcpServer/elicitation/request` as `{ action: 'decline', … }`,
  `execCommandApproval` and `applyPatchApproval` with a `ReviewDecision`, `item/tool/call`
  with `{ contentItems, success: false }`, and a method the adapter does not know with a
  JSON-RPC error (-32601). The two approvals a 0.6.0 host could meet are declined exactly
  as before.
- `./server/providers/codex-app-server`: `onApproval` no longer has a default of its
  own. A host's `onApproval` still sees every request first and an object it returns is
  still sent as given; when it returns nothing or throws, the request goes on to the
  run's `onAsk` and then to a decline in the request's own shape (before: always
  `{ decision: 'decline' }`).
- `./server/providers/codex-app-server`: `capabilities.textStream` is `true`.
  `turn/start` now names the approval policy on every turn (`'never'` unless the run
  says otherwise, which is what the thread already had).
- All adapters: `capabilities` gains `asks`, `steer` and `resume`. `provenance` gains
  `memory` on `codex-app-server` and `acp`. A test that compares either object exactly
  needs the new keys.
- `./server/providers/acp`: a session id handed to `run()` after `reset(key)` forgot
  that session is no longer loaded again; a new session starts. Before, the id was
  loaded if the agent still had it.

Added:

- `./server/conversations`: the event log (options `coalesce`, `coalesceChars`,
  `compactEvery`, `compactBytes`, `keepEvents`, `keepBytes`); `store.update(key, turnId,
  fn)`; `store.snapshot`, `subscribe`, `position`, `subscribers`, `compact`;
  `readConversation(dir, key)`, `logNameFor(key)`; `tools.text` and `turn.preview`;
  asks (`tools.ask`, `store.answer`, options `onAsk` and `askTimeout`, `turn.asks`, error
  code `answered`); steering (`store.steer`, option `steer`, `tools.steering`,
  `turn.steers`); memory (`conversation.memory`, `tools.resume`, `store.forget`).
- `./server/events`: `applyEvent`, `EVENT_TYPES`, `formatCursor`, `parseCursor`. No imports.
- `./server/stream`: `streamConversation(store, key, req, res, options)`.
- `./stream-client`: `followConversation(url, options)`.
- `./server/providers` (contract): `createBatcher`, `chosenOption`, `ASK_OPTIONS`; request
  option `onAsk`; `provider.steer`; error code `ended`.
- `./server/providers/codex-app-server`: `onText`, `streamOutput`, `streamBatch`;
  `onAsk`, `approvalPolicy`, `CODEX_REQUESTS`; `steer(key, input)`; `threadId` on a run
  and `provenance.memory`.
- `./server/providers/acp`: `onAsk` on a run; `provenance.memory`.
- `./server/mcp`: `createMcpServer`, `serveMcp`, `serveMcpBridge`, `describeTools`.
- `scripts/codex-real-check.mjs`, `scripts/mcp-real-check.mjs` (neither in `npm test`).
- The soak covers compaction, half-written log lines and resumed subscriptions.

Measured (`bench/RESULTS.md`, the 0.6.0 code against this, same session): one activity
update written to a 200-turn conversation, 10.8 ms to 0.16 ms; a burst of 150 sends,
198 ms to 17 ms; `save(key)` after changing one finished turn, 10.5 ms to 2.2 ms, and
`update()` 0.11 ms. Opening a conversation is slower, 1.2× to 1.8× (about 10 ms against
6 ms for 200 turns), and the store holds 3 to 10 per cent more memory.

Run against real programs on 2026-11-24 (Codex CLI 0.171.0, signed in, model
`gpt-6.2-sol` as the app-server's default):

- `scripts/codex-real-check.mjs`, all four parts observed. (a) A four-sentence reply
  arrived as 12 `turn.text` events over about a second and a half, all of them before
  the turn finished, and they added up to the final message. (b) A steer sent after the
  first of three `sleep 3` commands changed the final reply from DONE to PELICAN, was
  recorded on the turn, and a steer after the turn ended was answered `ended`; with
  `streamOutput` each command's output arrived as an `append` event. (c) With
  `approvalPolicy: 'on-request'` and a write outside the writable roots, one
  `item/commandExecution/requestApproval` became a pending ask, was answered `accept`
  through `store.answer()`, and the file was written. Only the accept path and only
  this kind of ask were exercised. (d) After closing the store and the provider (the
  app-server process exited) and making both again, the next run resumed the same
  thread (`provenance.memory: 'resumed'`) and recalled the word from the turn before.
- That run also showed that Codex repeats the previous turn's usage report after
  `thread/resume`; usage for the first turn after a resume is computed from it.
- `scripts/mcp-real-check.mjs`: Codex's MCP client (it asked for protocol 2025-06-18)
  completed the handshake with `./server/mcp`, listed both tools, called one and read a
  failed call. Its `resources/list` was refused with -32601 and it carried on. No client
  of the 2026-07-28 revision was available: that half is tested against the
  specification as read, not against a client.

Not checked against a real agent: every ask kind but a command approval; a decline or
`cancel`; `thread/resume` of a thread Codex no longer has (the `'lost'` path); anything
in the ACP adapter's new code (its tests use the fake agent); the stream helper in a
real browser.

## 0.6.0 (2026-11-24)

A hardening pass: an audit of every server module for what goes wrong under a crashing
child, a damaged file, a hostile answer or a racing request, with a failing test written
before each fix. Benchmarks (`npm run bench`, figures in `bench/`) and a soak
(`npm run soak`) are new. The README has a "Guarantees and limits" section. No export
path or signature was removed; every addition is optional.

Behaviour changes (what a host could notice without opting in to anything):

- `./server/conversations`: a conversation file that does not parse, is not a
  conversation, or belongs to another key is **moved aside** (`<name>.corrupt-<time>` or
  `.foreign-<time>`) and reported through `onError`. Before, the next write replaced it.
- `./server/conversations`: a conversation file that exists but cannot be read (a
  permission or I/O error) makes `open()` and `send()` reject with `code: 'unreadable'`.
  Before, it was taken as an empty conversation and then overwritten.
- `./server/conversations`: `busy()` is true, and `reset()` refused, from the moment a
  request is accepted, not from the moment it is written. A request stopped (by `stop`,
  `stopAll` or `close`) while it was still being written no longer runs.
- `./server/conversations`: after `close()`, `send()` and `reset()` reject with
  `code: 'closed'` and the store writes nothing more. Before, it carried on.
- `./server/conversations`: a field called `requestId` on a request now also makes the
  send safe to repeat: a second send with the same value returns the first turn.
- `./server/conversations`: `run` is not called for a turn that was stopped before it
  began; `tools.activity()` returns null once a turn has its final status.
- `./server/providers/codex-app-server`: a stop the agent does not confirm within
  `stopGrace` (**default 10 seconds**) ends the run as `stopped` and forgets the thread.
  Before, the run stayed open until its timeout (15 minutes by default).
- `./server/providers/codex-app-server`: a second `run()` on a key is refused with `busy`
  while the first is still starting. An abort while the child or thread is starting
  rejects at once. Failures before the turn starts are `ProviderError`s (`unavailable`),
  not plain errors. `onApproval` may return a promise.
- `./server/rpc`: lines from the child over 64 MB (`maxLine`) are dropped. `close()`
  rejects waiting calls at once and sends SIGKILL after `killGrace` (2 seconds). Errors
  are `RpcError`s with a `code`. Stderr is drained even with no listener.
- `./server/providers/cli-oneshot`: a stopped, timed-out or flooding child is sent SIGKILL
  two seconds after SIGTERM. `runProcess` keeps no output past `maxOutput` and
  marks the result `truncated: true`. A command that cannot be spawned rejects with a
  `ProviderError` (`unavailable`).
- `./server/providers/http-chat`: a stream that ends with no finish reason and no end
  marker rejects with `unavailable` ("cut off"). Before, the partial text was returned as
  the answer. A reply over 16 million characters (`maxResponse`) is refused. A 200 answer
  that is not JSON is `failed`, not `unavailable`. At most 1,000 keys are remembered
  (`maxKeys`). Anything in an error message that matches the API key or a configured
  header value is replaced with `[redacted]`.
- `./server/commands`: an oversize body is answered with 413 rather than a reset
  connection; a body that stalls for 30 seconds (`bodyTimeout`) is answered with 408.
- `./server/worklog`: a trail rotates at 8 MB (`maxBytes`), keeping one older file, as
  the work log does. Before, it grew without limit.
- `./server/routine-set`, `./server/routines`: a routine file that is not JSON, or has no
  `code`, is left out of the list. Before, it made `list()`, `get()`, `resolve()` and
  `turnFor()` throw. A `name` field inside a file no longer overrides the file's name.
- `./server/profiles`: a profile file that is not a JSON object is left out and reported
  in `list().errors`; the source's other profiles are still listed.
- `./server/threads`, `./server/history`: a threads file or history index that does not
  parse is moved aside and reported through `onError`; history rebuilds its index from
  the version files. Before, every later call threw.
- All child processes are sent SIGTERM when the host process exits normally.

Fixed (each with a test that failed before):

- `./server/rpc`: a line that was JSON but not an object (`null`) threw inside the reader
  and took the host process down.
- `./server/providers/codex-app-server`: two runs started together on one key both got a
  thread. Notifications with `params: null`, a null item or a non-text delta threw.
- `./server/providers/cli-oneshot`: a multi-byte character split between two chunks of a
  child's output was corrupted. A child that ignored SIGTERM kept running, and with
  runaway output its text kept accumulating until the process ran out of string.
- `./server/providers/http-chat`: `sseEvents` treated a CR at the end of one chunk and
  the LF at the start of the next as two line endings, and copied its whole buffer for
  every chunk (4 MB in 1 KB chunks took nine seconds).
- `./server/conversations`: a `turns` list holding something that is not a turn left its
  key failing for the life of the process. A leftover temporary file with loose
  permissions gave the conversation file those permissions for one write. Two stores on
  one folder shared a temporary file name.
- `./server/proposals`: the check that an edit's text occurs once could take 25 seconds
  for a long `find` in a large document of repeating text. The search is now linear.
- `./server/worklog`: `shapeOf` (used by `suggestRoutines` on code agents wrote) had a
  pattern that backtracked exponentially on `/[a][a][a]…` with no closing slash. A log
  line cut short by a crash swallowed the entry written after it.
- `./server/profiles`: `createBindings` returned members of `Object.prototype` for
  documents named `constructor` or `__proto__`.
- `./server/history`: parts named like `Object` members were never reported as added.
- `./server/commands`: a request line the URL parser rejects made `handle()` reject.

Added (all optional):

- `./server/conversations`: `requestId` on `send`; options `fsync`, `stopGrace`,
  `evictAfter`; `unload(key)` and `loaded()`; error codes `unreadable`, `corrupt`, `closed`.
- `./server/rpc`: `RpcError`, `createLineReader`; options `maxLine`, `killGrace`,
  `processGroup`; events `stderr`, `oversize`, `unparsed`, `fault`.
- `./server/providers/codex-app-server`: options `stopGrace`, `killGrace`, `maxLine`,
  `processGroup`; `idleTimeout` on a run.
- `./server/providers/cli-oneshot`: `validate` on a run; `processGroup`; `killGrace` on
  `runProcess`.
- `./server/providers/http-chat`: `retries` and `retryDelay` (off by default; only
  before any answer has arrived; honours `Retry-After`), `idleTimeout`, `maxResponse`,
  `maxKeys`; `sseEvents(body, { maxEvent })`.
- `./server/commands`: `bodyTimeout`; `rotate()` on the endpoint.
- `./server/history`, `./server/threads`: `fsync`, `onError`.
- `./server/activity`: `drop(doc)`, `size()`.
- `./server/routine-set`: `onError`. `./server/worklog`: `maxBytes` on a trail.
- `./server/proposals`: `occurrences(body, needle, limit)`.

Faster, measured (`bench/RESULTS.md`): the activity feed with many events kept, a burst
of sends to one conversation, one large server-sent event in small chunks, listing and
reading history, and the proposal check on awkward text. Not faster: one write of a
large conversation, and saving a history version.
### Also in 0.6.0: an Agent Client Protocol provider

Added:

- `./server/providers/acp`: `AcpProvider`, a client for the Agent Client Protocol
  (protocol version 1), so a host can drive any ACP agent (Gemini CLI, OpenCode, Goose and
  others) through the provider contract. Keyed sessions with `session/load` and
  `session/resume`; `session/update` mapped to streamed text, reasoning, tool-call and
  plan activity; `fs/read_text_file` and `fs/write_text_file` served by host hooks
  (reads only inside configured roots and writes refused by default); permission requests
  answered by a hook that may wait for a person, refused by default; terminals only with
  host hooks; MCP servers passed through; cancel, overall and idle timeouts, reset; an
  `auth` error naming the agent's sign-in methods. Also exported from `./server/providers`.
- `diffToEdit`: an ACP diff as a `./server/proposals` text edit, or why it is not one.
- `server/jsonrpc-stdio.mjs`: the JSON-RPC 2.0 stdio transport the adapter uses (not an
  entry point). `./server/rpc` (`CodexRpc`) is unchanged.
- `scripts/acp-real-agent.mjs`: one small real session per installed agent; not part of
  `npm test`. Run on 2026-11-24: OpenCode 2.2.5 and Goose 1.33.1 replied; Gemini CLI
  0.66.0 was not signed in and gave the `auth` error.

Unchanged: every 0.5.0 export path and signature, the contract, and the other adapters.

## 0.5.0

Renamed from `@lyra-forge/agent-chat` to `@lyra-forge/leyline`. No API or export path changed. Telemetry attribute names follow the package name: `agent_chat.*` is now `leyline.*`.

## 0.4.1 (2026-11-23)

Found while moving Copycat's server onto the package.

Added:

- `./server/conversations`: the `messages` entries `stopped`, `removed` and `interrupted`
  may each be a function of the turn. Copycat keeps two kinds of request in one
  conversation (a one-shot agent that only proposes, and a live agent that edits as it
  goes), and what a stopped request leaves behind differs between them. A plain string
  works as before; a function that returns nothing falls back to the library's sentence.

Changed:

- `docs/adopting.md`: Copycat's steps have been carried out (its branch `adopt-package`);
  a new section lists where its code went differently from the steps as written.
- The 0.4.0 note "no host has adopted any server module" no longer holds for Copycat.

Unchanged: every 0.4.0 export path and signature, and the UI.

## 0.4.0 (2026-11-23)

The package widens from the chat panel to the patterns around it. `docs/patterns.md` is
the inventory: what each pattern does, where it lives in Toucan, Copycat and Skein, and
whether it is here or stays in the host.

Added, all as plain `.mjs` with no dependencies:

- `./server/routine-set`: shipped and banked routines as one set, kinds, `when` and `args`
  notes, slash names, a routine as a request, validated save, remove with an archive,
  JSON and comment-header file formats.
- `./server/history`: versions of an opaque document (save, list, read, restore, prune)
  and a checkpoint per request, so a whole request can be undone by a restore.
- `./server/proposals`: edits an agent offers or makes, their fates, feedback told once,
  undo of one edit or of a whole request. Find-and-replace text is built in; other kinds
  are the host's.
- `./server/activity`: a feed of what people did, attributed by claims, with a place per
  reader.
- `./server/threads`: comment threads with opaque anchors, and handing one to an agent.
- `./server/profiles`: named agents a document can be bound to, and a helper that turns a
  profile into a provider request.
- `./server/worklog`: a work log with routine statistics and suggestions, and a
  per-document trail.
- `docs/patterns.md`, `docs/adopting.md`.

Changed:

- The Codex adapter's `run` takes a `model` for that run.
- Server code reads the package name from `package.json`, so a rename is one edit. The
  README's "Name" section lists what else a rename touches.
- The default Codex client name and telemetry scope are derived from the package name
  (they were the literal `agent-chat`; the values are the same until a rename).

Fixed:

- The Codex adapter could ask for a turn to be interrupted twice when a stop arrived
  before the turn's id was known. It now asks once.
- The conversation store reported a conversation as busy for a moment after its turn
  had its final status (while the last write finished), so a reset or a strict-queue
  send made at once could be refused. A turn with its final status no longer counts.
- Three tests could fail on a busy machine (a store still writing while its folder was
  removed, and two that asserted before the thing they waited for). The library code was
  not at fault; the tests now wait for what they assert on.

Unchanged: every 0.2.3 and 0.3.0 export path, and the UI.

Not done: no host has adopted any server module; reflexes, presence, the brief, draft
sync, the review log, plans and references stay in the hosts. See the README.

## 0.3.0 (2026-11-23)

The package moves out of Toucan into its own repository. The first commit here is 0.2.3
unchanged (Toucan branch `extract-agent-chat`, `packages/agent-chat`, commit `9cec9c0`).

Added, all as plain `.mjs` with no dependencies:

- `./server/providers`: one `AgentProvider` contract with normalised activity events, and
  three adapters. `codex-app-server` and `cli-oneshot` are generalised from Copycat and
  Skein. `http-chat` is new: OpenAI-compatible and Anthropic-compatible HTTP endpoints,
  text only.
- `./server/conversations`: the turn store, with a queue, parallel lanes, private
  atomic files, recovery after a restart, archive on reset, and stop.
- `./server/commands`: the loopback-with-a-private-key pattern for an agent's CLI.
- `./server/telemetry`: an optional `onCall` hook and an OTLP reporter that is off
  unless a host gives it a URL.
- Tests (`npm test`) and a syntax check (`npm run check`).

Unchanged: every 0.2.3 export path, the UI components and their props, `CodexRpc`, and
the routine bank. A consumer of 0.2.3 can move to 0.3.0 without changing code.

Changed: `engines.node` is now stated (`>=22`); `./package.json` is exported.

Not done: see "Not done yet" in the README.

## 0.2.3

The version Skein and Copycat pinned from Toucan: the chat UI, `./server/rpc` and
`./server/routines`.
