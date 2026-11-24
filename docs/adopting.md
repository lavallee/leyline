# Moving a host onto the package

> **Status, 2026-11-23.** Copycat runs on Leyline 0.5.0 for its chat panel, live agent,
> one-shot agents, conversation store, routines, proposal bookkeeping and command
> endpoint. Skein uses 0.5.0 for the chat panel, the JSON-RPC transport and the routine
> bank, with its own conversation code unchanged. Toucan has not adopted it: its chat
> needs steering of a running turn and approvals shown to a person, which Leyline lacks.

Steps for Copycat, Skein and Toucan, written from reading their code on 2026-11-23.
Each is a change to another repository, to be made and tested there. File and function
names are the hosts' own.

**Copycat's steps were carried out on 2026-11-23** (its branch `adopt-package`, pinned at
0.4.1, not merged at the time of writing). Section 2 is kept as it was written, and
"What Copycat's adoption found" below it lists where the code went differently.
**Skein's and Toucan's steps have not been carried out.**

Every step is separate: a host can stop after any of them. Do step 1 first.

## 1. Pin the new version (Copycat, Skein)

1. From a clean checkout of this repository at the commit to pin: `npm test && npm run check`,
   then `npm pack --pack-destination <host>/vendor`.
2. In the host: `npm install ./vendor/lyra-forge-leyline-0.4.0.tgz`.
3. Update `vendor/leyline.json`: `version`, `artifact`, `integrity` (sha512 of the
   tarball, base64), `revision` (this repository's commit), `directory: "."`, and
   `source` once this repository has a home. In `scripts/update-chat-library.js` the
   status check and `npm pack` run on `.` instead of `packages/agent-chat`.
4. `npm run build:chat` and the host's tests. No code changes: every 0.2.3 import still
   resolves and the UI source is byte-identical.

## 2. Copycat

### Agent: `src/live.js` → `./server/providers`

```js
this.live = new CodexAppServerProvider({ command, workDir: path.join(stateDir, 'agent-work'),
  clientInfo: { name: 'copycat', title: 'Copycat', version }, threadConfig: { 'features.multi_agent': false } });
```

In `runLive`, `this.live.run({...})` becomes:

```js
this.live.run({ key: lane.id, instructions, input, effort: turn.mode === 'thorough' ? 'medium' : 'low',
  sandbox: { mode: 'workspace-write', cwd: state.root, writableRoots: [workspace, this.live.workDir], network: true },
  onEvent: tools.activity, signal, timeout: (page.chat.timeout || 900) * 1000 })
```

Changes to expect: `live.work` is `live.workDir`; `mode` is `effort`; errors are
`ProviderError`s with a `code`, and the wording "Your draft is kept" is no longer in the
library, so map codes to Copycat's messages. Delete `src/live.js`.

### One-shot presets: `src/agent.js` → `CliOneshotProvider`

`PRESETS`, `run` and `parseAnswer` become
`new CliOneshotProvider({ ...page.agent, timeout: (page.agent.timeout || 300) * 1000 }).run({ input: prompt, cwd: root, outputSchema: SCHEMA, json: true, signal })`.
The answer is `result.data`. Copycat's timeout is in seconds; the library's is in
milliseconds. `AgentRunner.prepare` and the edit checks stay.

### Turn store: `src/chat.js` → `./server/conversations`

Delete `this.conversations`, `this.running`, `this.queues`, `this.writes`, `persist`,
`pump`, the recovery loop in `conversation()`, and the bodies of `stop` and `reset`.

```js
this.store = createConversationStore({ dir: path.join(stateDir, 'chats'), maxLanes: 4,
  run: (turn, lane, signal, tools) => this.runLive(turn, lane, signal, tools),
  onLaneClosed: lane => { if (!lane.main) this.live.reset(lane.id); },
  describeActivity: (event, item) => /* today's describe(command, workspace) and the "Writing …" title */,
  describeFailure: error => /* a Problem's message, or "The agent could not finish: …" */,
  messages: { interrupted: 'The editor restarted. Your request is kept; send it again to continue.',
              stopped: 'Stopped. What it had already changed is in your draft.' } });
```

- `conversation()` still computes the key and fills `this.pages`, then `store.open(key)`.
- `sendLive` → `store.send(key, { user: shown, live: true, mode, files, focus, proposals: [], payload: { prompt, focus, comment, undone } })`.
- `stop` → `store.stop(key, id)`; `reset` → `store.reset(key)` then `this.live.reset(`${key}:main`)`; `busy` → `store.busy(key)`.
- `runLive` returns `{ message, provenance }` instead of setting the status. `turn.stopped` goes: the store records `stopped` from the signal.
- In `agent()`: `this.running.get(id)` → `this.store.running(id)`; `runtime.later?.()` → `this.store.save(key)` (written at once, not after 600 ms).
- Existing chat files load as they are: the same `{ key, turns }` shape under `<key>.json`.

### Routines: `SHIPPED`, `routines()`, `saveRoutine`, `removeRoutine` → `./server/routine-set`

```js
this.routines = createRoutineSet({ shipped: SHIPPED, bankedDir: path.join(stateDir, 'routines'), engines: ['page'] });
```

- `routines()` → `this.routines.list()`.
- The slash block in `send()` → `const { user: shown, prompt, routine } = this.routines.turnFor(request.message, { engine: 'page' })`. An unknown `/name` throws a `RoutineError` with the same sentence as today; map it to a `Problem`.
- `saveRoutine` → `this.routines.save(request.name, { title, description, prompt })`; `removeRoutine` → `this.routines.remove(request.name)`.
- Banked files keep their format and place. The archive name gains nothing new (`<name>-<8 hex>.json`, as today).

### Proposals: `agent('edit')`, `sync`, `missed` → `./server/proposals`

```js
const proposals = createProposals({ wording: {
  undone: label => `The owner undid your edit “${label}”. Do not repeat it; read the draft again.`,
  stale: label => `The owner had changed that text, so the page did not take your edit “${label}”. Do not repeat it; read the draft again.` } });
```

- In `agent('edit')`, the body of the `map` becomes `const made = proposals.make(turn, edit, texts)`; on success `texts = shared = made.doc`. Build the answer line from `made.ok` and `made.code` (`not-found`, `ambiguous`, `no-change`, `unknown-file`) to keep today's wording.
- In `sync`, the loop over `seen` becomes `proposals.report(conversation.turns.slice(-12), request.seen)` followed by `kept = proposals.replay(conversation.turns.slice(-12), kept)`.
- `missed(turn)` → `proposals.feedback(turn)`.
- The one-shot path's `edits.map(…)` check in `AgentRunner.ask` → `proposals.offer(turn, edit, { doc: texts })`, which records `ok` and `problem` the same way.
- Stored proposals need no migration: the fields are the same, and a proposal with no `kind` is text.
- **Stays in `extension/editor.js`:** `applyProposal`, `applyAgentEdits`, `markChanges`, `flash`, `showProposal`, and for now `undoProposal` and `undoTurn`, because the browser holds the real draft. Moving undo to the server (`proposals.undo`, `proposals.undoRequest`) needs the one-authoritative-draft change the design study recommends; until then the browser keeps undoing and reports fates.

### Comments handed to the agent: `src/review.js`

Two choices, and the first is the default until the owner decides otherwise.

- **Keep `ReviewStore` as it is.** Comments stay in the source repository in their
  current format. Use only `promptFor`-style wording if wanted. Nothing to do.
- **Adopt `./server/threads`.** Pass `storage` that reads and writes the page's comments
  file, and `cleanAnchor` wrapping `anchor()`. This changes the file format (a comment
  becomes a thread with `messages`; `resolved` becomes `closed`; `history` is dropped),
  so it needs a migration of existing comment files and the owner's agreement.
  `sendLive`'s comment branch then becomes
  `threads.handOff(key, id, ({ prompt }) => /* store.send … */, { where: t => /* this.where(...) */ })`,
  and the agent's `reply` operation calls `threads.agentAnswered`.

### History (new for Copycat)

Optional. `createHistory({ dir: path.join(stateDir, 'history') })`, then in `runLive`
`history.checkpoint(key, turn.id, { data: texts, parts: texts })` before the agent
starts. That gives a restore point per request without touching the browser's undo. A
"restore" button needs the browser to accept a whole replacement draft, which it does
not do today.

### Activity (new for Copycat)

Optional, and small until the draft is server-held. `createActivityFeed()` with no
snapshot; in `sync`, when a file's text differs from the last one seen, call
`feed.changed(key, [{ id: file, change: 'updated' }], { actor: { kind: 'person' } })`;
in `agent('edit')`, `feed.claim` the file first. In `agent('show')` and `agent('edit')`,
add `formatActivity(describeEvents(feed.pending(lane.id, key, …).events, …))` to `notes`
and `ack`. The agent then hears "the owner changed content.md" with its next command.

### Commands: `bin/copycat-doc.mjs`, `/agent/` in `src/server.js` → `./server/commands`

- `session()` and `call()` in the CLI → `call({ app: 'copycat', name: `agent-${port}`, operation, data: { ...data, page } })`.
- The `/agent/` block → `createCommandEndpoint({ port, key: chat.agentToken, operations: { show, edit, comments, reply } })` and `if (await commands.handle(req, res)) return`.
- The `writeFile` of the session in `runLive` → `writeSession({ app: 'copycat', name: `agent-${port}`, url, key })`. The path is the same unless `XDG_STATE_HOME` is set, which the library honours.

### What Copycat's adoption found

Copycat had changed between the steps above being written and being carried out: a live
page's draft is now held by the server (one draft, a revision and a log of splices), and
an agent's edit to it is a splice there. Its `docs/approach.md` has the full account.
What the next host should know:

- **Pin.** `npm install ./vendor/<tarball>` and the rebuilt UI bundle was byte-identical
  to the 0.2.3 one, as promised. The pin script needed three changes: pack `.`, check the
  status of the whole repository, and remove the old tarball.
- **Provider errors.** Two messages needed mapping, not one: a lost connection
  (`unavailable`, "The agent connection stopped.") and a child that could not start,
  which the adapter prefixes with "The agent could not start: ".
- **Activity wording needs the turn.** `describeActivity` on the store receives the
  event and the item only. Copycat's wording depends on the page (its notes folder, its
  root), so it calls `foldActivity(turn.activities, event, { describe })` itself inside
  `run` and then `tools.save()`. Its `describe` also deletes `item.command` and
  `item.paths`, which `foldActivity` stores and Copycat does not want on disk.
- **Two kinds of request in one store.** Copycat's one-shot turns and live turns share a
  conversation. Both go through `store.send`; `run` branches on a field of the turn. The
  stop message differs between them, which is why `messages.stopped` may be a function of
  the turn from 0.4.1. A host that must know when a turn has fully ended (Copycat frees
  its one-shot agent then) can use `onLaneClosed`, which runs after the last write.
- **`store.save(key)` instead of a delayed write** in the agent's command route worked,
  awaited, so what a command changed is on disk before the agent hears back.
- **A stop can arrive before `run` is called.** `run` then receives a signal that is
  already aborted. The adapters check for that; a host's own `run` should too.
- **Routines.** `list()` sorts by title. Copycat's menu lists its shipped routines first,
  in its own order, so it re-sorts the list. `turnFor` fitted as written; the prefix
  Copycat adds for a routine run on a selection stays in Copycat.
- **Proposals with a server-held draft.** `make` checks, applies and records in one call,
  but the real document is the host's draft and its write can still be refused (a size
  limit) or fail. Copycat calls `make` with the draft's text at that moment, then makes
  the splice, then adds `shared`, `rev` and `fate: 'applied'` to the proposal `make`
  returned; if the splice is refused it takes the proposal out of `turn.proposals` again.
  `report` accepts any fate for any proposal, so Copycat filters what a browser says
  first: for an edit made in the shared draft, a browser's only news is `undone`.
  `replay` and `feedback` fitted as written. `offer` was not used for the one-shot path:
  that check also serves a panel with no turn, and its problem text is Copycat's.
- **Undo stayed in the browser.** Only files marked live have a server draft; the rest
  still have one draft per browser.
- **Commands.** Copycat passes `stateDir` to `writeSession` and `call` (the plain
  `~/.local/state`), so both sides agree whatever `XDG_STATE_HOME` says, and maps
  `call`'s "No copycat session found" back to its own sentence. `createCommandEndpoint`
  needed `maxBody` raised to Copycat's 4 MB.
- **Tests that reached into the old store** (setting a running turn by hand) now hold the
  host's `run` open instead and call the command route while it waits.

## 3. Skein

- **Agent:** `src/agent-provider.js` → `CodexAppServerProvider` with
  `clientInfo: { name: 'skein', … }` and
  `threadConfig: { 'features.shell_tool': false, 'features.unified_exec': false, 'features.multi_agent': false, web_search: 'disabled' }`.
  `generate()` becomes `run({ key, input: prompt, instructions: 'You edit only the thread text supplied by Skein…', effort, outputSchema: schema, onEvent, signal, timeout: 180000 })`; the sandbox default is read-only, as Skein wants. Parse `result.message` as JSON where `generate` did. Skein's "Agent update" notes are titled "Agent note" by the library.
- **Turn store:** `createConversationStore({ dir, maxLanes: 1, run })`. Skein refuses a
  second request rather than queueing it: check `store.busy(id)` before `store.send`.
  Its chat files have `thread` where the store has `key`; a file with no `key` is adopted
  under its file name, and gains a `key` field on its next write. `init()`'s directory
  scan goes: conversations are recovered as they are opened.
- **Routines:** as Copycat, with `engines: ['thread']` and Skein's four shipped routines.
  Skein's archive names are a bare UUID; the library's are `<name>-<8 hex>`. Old archive
  files are left where they are.
- **Proposals:** `proposals()` checks structured post operations. To use the ledger,
  write a `post` kind (`validate`, `check`, `apply`, `invert`, `label`) from that
  function and `offer` each change; fates then come for free. The length counting
  (`count`, `measure`) stays in Skein either way. This is optional: Skein's proposals are
  held, never automatic, and work today.
- **Not applicable today:** threads, activity, profiles, history. Skein has one author,
  one turn at a time and a draft in the browser.

## 4. Toucan

Toucan is the largest move, and the one with the most unknowns: it does not use the
package at all on `main`, and its chat is pushed over a websocket rather than polled.
In the order that risks least:

1. **Routines.** `server/routines.mjs` → `createRoutineSet({ shippedDir: 'routines', bankedDir: join(data, '_routines'), format: headerFormat(), engines: ['tldraw', 'excalidraw'], kinds: KINDS })`. Keep `program()` and the plan note in Toucan. Differences: `remove` archives where Toucan deletes; `save` validates names and sizes that Toucan does not.
2. **Versions.** `server/versions.mjs` → `createHistory({ dir, maxBytes })`, passing `shapes` as `parts`. **The on-disk layout differs** (`<data>/<canvas>.versions/` with an index of a slightly different shape, against `<dir>/<canvas>/`), so existing histories need a one-time migration script, not written here.
3. **Threads.** `server/threads.mjs` → `createThreadStore({ dir: data, cleanAnchor })`. The file name is the same (`<canvas>.threads.json`) and so is the shape, so existing threads should load; this was compared by reading, not by loading a real file. `describeAnchor`, `anchorLine` and sticky-note adoption stay; pass `anchorLine` as `where`.
4. **Activity.** `createActivity` → `createActivityFeed({ snapshot: rowsOf, diff, busy })`, where `diff` is the loop in `settle` that calls `rowChanges` (with the "carried by its frame" rule). `ran(canvas, actor, changes)` → `feed.claim(canvas, actor, ids)`; actor kind `canvas` → `system`; event type `shape` → `change`. `describe` becomes a `change` wording function for `describeEvents`.
5. **Profiles.** `server/profiles.mjs` → `createProfiles({ dir: join(data, '_profiles'), sources: plugins.map(commandSource) })`. Plugin discovery (`server/plugins.mjs`) stays. `profileInstructions` here has no Toucan-specific sentence about its CLI; add it in Toucan.
6. **Work log and trail.** `createWorkLog({ file: join(data, '_work/log.jsonl') })`, `suggestRoutines(entries, { routines, covers })` with `COVERED`, `DOES` and `touches` moved into Toucan's `covers`. Entry field `canvas` is `doc` here: old log lines need reading with that in mind. `createTrail({ dir: data })` writes `<canvas>.trail.jsonl` where Toucan writes `<canvas>.log.jsonl`.
7. **The agent and the chat.** `server/codex.mjs` → `CodexAppServerProvider` and `createConversationStore`. This was the hard one: Toucan shows approvals to the person, steers a running turn with activity, and streams events over a websocket, and until 0.7.0 the adapter answered approvals by callback only and could not steer. It can now do all three; section 6 below maps Toucan's code onto it and says what is still missing.
8. **The UI.** Bring `main`'s changes to the chat panel since 0.12.2 into `src/`, then have `app/Chat.tsx` import the package. The two panels were not compared feature by feature.

Reflexes, the brief, presence, plans, references and the review log stay in Toucan
(`docs/patterns.md`).

## 5. Copycat on 0.7.0: the stream, asks, steering, memory

None of this is done in Copycat; Copycat `main` runs unchanged on 0.7.0 (its test and
browser suites were run against a packed 0.7.0 on 2026-11-24). Each step below is
independent and can ship alone. File and function names are Copycat's as of that date.

**0. Nothing to migrate.** The chat files under `<state>/chats/` load as they are and
get a log beside them on first change. Two things to know: anything that reads
`chats/<key>.json` directly (a script, a backup) now sees a snapshot that can be behind
while the server runs, so use `readConversation(dir, key)` or read after a clean
shutdown; and going back to 0.6.0 is safe after `store.close()` has run (Copycat's
`close()` should call `await this.store.close()` for that reason; today it only closes
the agent).

**1. Proposal fates: `store.save(key)` → `store.update()`.** In `agent()`
(`src/chat.js`), `written()` calls `this.store.save(key)`, which now compares all 200
turns to find what changed (about 2 ms). Where a command changes one known turn, use
`this.store.update(key, turn.id, turn => { … })` (0.1 ms) and make the change inside
the function. Where one command touches several turns (an undo across requests), keep
`save(key)`: it is correct, only dearer. In `runLive`, the direct
`foldActivity(turn.activities, …); tools.save()` keeps working as it is.

**2. Replace polling with the stream.** Today `extension/editor.js` calls
`bridge.call('chat')` every 900 ms while a turn is active (`pollChat`), and the server
answers with the whole conversation each time.

- Server (`src/server.js`): add a `GET` route, say `/chat-stream?url=…`, beside the
  operations table. It must apply the same checks the `chat` operation's route applies
  (the stream helper does none), resolve the conversation as `chat.history` does
  (`const conversation = await chat.conversation(url, options)`), and then
  `streamConversation(chat.store, conversation.key, req, res)`. Routines and the `live`
  flag are not part of the conversation: keep `bridge.call('chat')` for the first load,
  or put them in an extra first event of Copycat's own before handing the response over.
- Browser (`extension/editor.js`): bundle `@lyra-forge/leyline/stream-client` and, in
  `loadChat`, replace the `pollChat()` call with
  `chat.feed = followConversation(streamUrl, { onChange: conversation => { takeHistory({ ...history, turns: conversation.turns }); render…(); }, onGap: … })`;
  delete `pollChat` and `chat.timer`. `takeHistory` already takes whole turn lists, so
  the first version can ignore the individual events. The "agent replied on a comment"
  check that `pollChat` does by counting `replied` becomes a comparison in `onChange`.
  Close the feed where the panel is torn down.
- **The one decision here is the owner's:** how the browser reaches that route. The
  operations go through `bridge.call` (the extension's background page), and a streamed
  `fetch` from the content script may not be allowed to reach the local server
  directly. Either the bridge grows a streaming call (a port that relays chunks), or the
  page fetches the stream itself where it is served by Copycat's own server. The client
  takes a `fetch` option for exactly this. Until that is settled, polling keeps working.
- Then turn on text: pass `onText: tools.text` in `runLive`'s `this.live.run({ … })` and
  show `turn.preview` in the panel while a turn runs. Optional: `streamOutput: true`
  changes what the activity item of a command holds while it runs (raw output until
  Copycat's `describe` rewords it at the end), so leave it off unless that is wanted.

**3. Asks.** Copycat runs with the sandbox as the boundary and never asks, so nothing
is needed. To let a person approve something: pass `approvalPolicy: 'on-request'` and
`onAsk: tools.ask` in `runLive`; give the store `onAsk: () => undefined` (or a policy
that answers the harmless ones); add an operation `'chat-answer': (data, o) =>
chat.answer(data.url, data, o)` that calls `this.store.answer(key, data.turn, data.ask,
data.decision)`; and render `turn.asks` with status `pending` as a question with the
ask's `options` as buttons. Without the store option the default policy declines at
once and nothing changes.

**4. Steering.** Give the store `steer: (input, turn, lane) => this.live.steer(lane.id,
input)` and add an operation that calls `this.store.steer(key, turnId, text)`. In the
composer, when a turn is running on the main lane, offer "tell the agent" beside
"send": on `{ steered: false, reason: 'ended' }` fall back to `chat-send` with the same
text. The package's activity feed is not wired to this: if Copycat wants "the owner
edited section 2" to reach a running turn, it decides when and calls `store.steer`.

**5. Memory across a restart.** In `runLive`, spread `...tools.resume` into
`this.live.run({ … })`. That is all: the store keeps the thread id from each turn's
`provenance`, and after a restart the first main-lane request resumes the thread.
`turn.provenance.memory` then says `resumed`, or `lost` if Codex no longer has it;
worth showing when it is `lost`. `chat.reset` already calls `store.reset`, which forgets
the id; keep calling `this.live.reset(`${key}:main`)` there as well.

**6. MCP instead of the CLI (optional).** `bin/copycat-doc.mjs` and the `/agent/` route
stay as they are. To offer the same four operations as MCP tools, add a script that
calls `serveMcpBridge({ app: 'copycat', name: `agent-${port}`, defaults: { page }, tools: […] })`
with a description and schema for `show`, `edit`, `comments` and `reply`, and name it in
`threadConfig.mcp_servers` for the live provider. Note that `disableUserExtensions`
turns off the servers in the user's own configuration, not ones a host adds.

## 6. Toucan on 0.7.0: what `server/codex.mjs` maps onto

Read from `server/codex.mjs` on 2026-11-24; nothing was run.

| Toucan today | With the package |
| --- | --- |
| `thread/start` or `thread/resume` from `this.saved[key]` | `provider.run({ key, threadId: saved })`; the store keeps the id (`tools.resume`) and `provenance.memory` says what happened |
| `turn/steer` with `expectedTurnId`, used to send a chat message or "what people did" into a running turn | `store.steer(key, turnId, input)` or `provider.steer(key, input)`; `reason: 'ended'` is the case Toucan handles by starting a turn |
| `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` forwarded to the browser, answered by `{ type: 'approve', key, decision }` over the websocket | `approvalPolicy: 'on-request'`, `onAsk: tools.ask`, store option `onAsk: () => undefined`; the browser sees `turn.asks` and the server calls `store.answer(key, turnId, askId, decision)` |
| every other server request answered `{ decision: 'decline' }` | answered in its own shape by the adapter |
| `item/agentMessage/delta`, reasoning deltas and `item/commandExecution/outputDelta` sent to open tabs only | `onText: tools.text`, `onEvent: tools.activity`, `streamOutput: true`; they become `turn.text` and `turn.activity` events |
| `this.history`: the last 400 events per canvas replayed to a tab that joins | `store.snapshot()` then `store.subscribe(key, { after })`: a snapshot plus the events after it, so a late tab gets the state rather than a replay |
| a websocket per canvas | Toucan's websocket can stay: subscribe once per canvas with `{ raw: true }` and send each line to the canvas's sockets, with `snapshot()` for a tab that joins. Or use `streamConversation` and Server-Sent Events for the chat and keep the websocket for the canvas. |

What is still missing for Toucan, as far as reading shows:

- **Its event vocabulary is not the package's.** Toucan's browser expects `delta`,
  `reasoning`, `output`, `plan`, `approved` and item events keyed by Codex item ids; the
  package sends turn-shaped events (`turn.text`, `turn.activity` with folded items,
  `turn.ask`). `app/Chat.tsx` would be rewritten onto turns, or a mapper written in
  Toucan. This is the largest piece of the move and is UI work, not protocol work.
- **Plans.** Toucan treats `turn/plan/updated` specially (only the latest plan is
  replayed). The adapter reports a plan as an ordinary activity item from the `plan`
  thread item and does not read `turn/plan/updated` or `item/plan/delta`.
- **Several people on one canvas.** The store's asks are answered by whoever calls
  `answer()` first; Toucan would decide who may. Presence, the brief and reflexes stay
  in Toucan as before.
- **Steering as a first message.** Toucan steers with several inputs at once (what
  people did, the selection, the message). `steer` takes a list of strings as parts of
  one message, which covers that; images or mentions as steer input are not passed
  through (the adapter sends text parts only).
- **Not verified:** that Toucan's `approvalPolicy: 'on-request'` threads behave the same
  when the policy is also named on each `turn/start`, as the adapter now does; and
  whether Toucan relies on `thread/resume` returning the thread's turns, which the
  adapter does not ask for (`excludeTurns: true`).
