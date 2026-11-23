# Moving a host onto the package

Steps for Copycat, Skein and Toucan, written from reading their code on 2026-11-23.
**None of these steps has been carried out.** Each is a change to another repository,
to be made and tested there. File and function names are the hosts' own.

Every step is separate: a host can stop after any of them. Do step 1 first.

## 1. Pin the new version (Copycat, Skein)

1. From a clean checkout of this repository at the commit to pin: `npm test && npm run check`,
   then `npm pack --pack-destination <host>/vendor`.
2. In the host: `npm install ./vendor/lyra-forge-agent-chat-0.4.0.tgz`.
3. Update `vendor/agent-chat.json`: `version`, `artifact`, `integrity` (sha512 of the
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
7. **The agent and the chat.** `server/codex.mjs` → `CodexAppServerProvider` and `createConversationStore`. This is the hard one. Toucan shows approvals to the person, steers a running turn with activity, and streams events over a websocket; the adapter answers approvals by callback only and cannot steer. Either the adapter grows those two things first, or Toucan keeps `server/codex.mjs`.
8. **The UI.** Bring `main`'s changes to the chat panel since 0.12.2 into `src/`, then have `app/Chat.tsx` import the package. The two panels were not compared feature by feature.

Reflexes, the brief, presence, plans, references and the review log stay in Toucan
(`docs/patterns.md`).
