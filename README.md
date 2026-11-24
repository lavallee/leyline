# Leyline

The working parts of tools where people and coding agents share a document: a chat
panel, and behind it agent providers, conversations, routines, history, proposals,
an activity feed, comment threads and agent profiles. It was extracted from three such
tools: Toucan (a canvas), Skein (a thread editor) and Copycat (an in-place document
editor). `docs/patterns.md` lists each pattern, where it lives in each tool, and what is
and is not in this package.

The package began as the chat panel only, and its name no longer fits. It stays
`@lyra-forge/leyline` until the owner chooses another; see [Name](#name).

- ESM only, Node 22 or later.
- The server modules are plain `.mjs` files with no dependencies. Nothing needs building
  to use them.
- The UI is React, shipped as TSX source. Your bundler compiles it, as before.
- MIT licence.

## What is in it

| Entry point | What it is |
| --- | --- |
| `.` , `./ui/*`, `./dock`, `./activity`, `./routine-menu`, `./theme.css` | The chat panel: header, conversation, composer, activity transcript, dock and resize, routine menu, UI primitives. Unchanged from 0.2.3. |
| `./routines` | Routine slugs and slash matching. Unchanged. |
| `./server/rpc` | `CodexRpc`: a JSON-RPC process transport over stdio. Unchanged. |
| `./server/routines` | `createRoutineBank`: routine storage. Unchanged. |
| `./server/providers` | One contract for agents, and three adapters. 0.3.0. |
| `./server/conversations` | The turn store: queue, lanes, persistence, recovery, stop. 0.3.0. |
| `./server/commands` | How an agent with a shell reaches the host: a private key over loopback. 0.3.0. |
| `./server/telemetry` | An optional hook, and an OTLP reporter that is off unless configured. 0.3.0. |
| `./server/routine-set` | Shipped and banked routines as one set: kinds, slash names, a routine as a request, save, remove. 0.4.0. |
| `./server/history` | Versions of a document: save, list, restore, prune, and a checkpoint per request. 0.4.0. |
| `./server/proposals` | Edits an agent offers or makes: fates, feedback, undo one or a whole request. 0.4.0. |
| `./server/activity` | What people did meanwhile, with a place per reader. 0.4.0. |
| `./server/threads` | Comment threads, and handing one to an agent. 0.4.0. |
| `./server/profiles` | Named agents a document can be bound to. 0.4.0. |
| `./server/worklog` | What agents did: routine statistics, suggestions, and a per-document trail. 0.4.0. |

Each adapter can also be imported alone: `./server/providers/codex-app-server`,
`./server/providers/cli-oneshot`, `./server/providers/http-chat`.

## What stays in the host

The package does not know what a document is. These stay with each host:

- The document model, and checking an agent's proposed change against it.
- Permissions and sandbox policy: which folders an agent may write, whether it has
  network access, which approvals are granted, whether the user's own MCP servers and
  plugins are switched off.
- Instructions and prompts.
- Saving and publishing, and who may open the page.
- The operations an agent may call (`show`, `edit`, and so on). `./server/commands`
  carries them; it does not define them.
- What an edit is and how it is shown: `./server/proposals` keeps the ledger, the host
  applies changes to what the person sees.
- Anchors: where a comment sits and how to find that place again.
- How two states of the document differ, and how a change reads in a sentence.
- Running a routine. Reflexes, presence and the brief sent with each message
  (`docs/patterns.md` says why).

Sharing a transport does not share document access or execution authority.

## The UI

```tsx
import { ChatHeader, ChatComposer, Conversation } from '@lyra-forge/leyline';
import { ChatDock, DockButtons, useChatLayout } from '@lyra-forge/leyline/dock';
import { ActivityLog } from '@lyra-forge/leyline/activity';
import { Button } from '@lyra-forge/leyline/ui/button';
```

React 19 is a peer dependency. Generate Tailwind utilities from the package source and
supply your theme tokens (see `src/theme.css`). Hosts clear the draft after accepting a
send. The components and their props are the same as in 0.2.3.

## Providers

A provider turns one request into one reply, and may report what it is doing on the way.

```
provider.name            'codex-app-server' | 'cli-oneshot' | 'http-chat'
provider.capabilities    { activity, textStream, sessions, cancel, shell, structuredOutput }
provider.run(request)    -> Promise<{ message, provenance, usage? }>
provider.cancel(key)     stop the run for that key
provider.reset(key)      forget what the provider remembers for that key
provider.close()
```

A request, common to all adapters:

| Field | Meaning |
| --- | --- |
| `key` | A host string naming the conversation. Providers with `sessions` keep memory under it. A new key is a fresh agent. |
| `input` | A string, or a list of strings sent as parts of one message. |
| `instructions` | Standing instructions (a system prompt). |
| `onEvent(event)` | Called with each activity event, where the provider has `activity`. |
| `onText(piece)` | Called with pieces of the reply as they arrive, where the provider has `textStream`. |
| `signal` | An `AbortSignal`. Aborting rejects with code `stopped`. |
| `timeout` | Milliseconds. |

Activity events are normalised, whatever the provider:

```
{ id, kind: 'reasoning' | 'activity', status: 'running' | 'done' | 'failed' | 'stopped',
  title?, text?, command?, paths? }
```

Two more fields carry streaming: `append` (text to add to this item, instead of replacing
it) and `output` (the tail of a finished command's output). Events with the same `id`
describe one item as it changes. `foldActivity(items, event)` keeps a list up to date
from them; that list is what `ActivityLog` renders.

Errors a provider raises on purpose are `ProviderError`s with a stable `code`
(`stopped`, `timeout`, `unavailable`, `auth`, `busy`, `config`, `failed`) and an HTTP
`status` a host may answer with. Read `capabilities` and hide what a provider cannot do.

### codex-app-server

A long-lived agent over the Codex app-server protocol: one child process, one thread per
key, activity streamed while it works.

```js
import { CodexAppServerProvider, foldActivity } from '@lyra-forge/leyline/server/providers';

const agent = new CodexAppServerProvider({
  command: ['/usr/local/bin/codex', 'app-server'],
  workDir: '/var/lib/myhost/agent-work',
  clientInfo: { name: 'myhost', title: 'My Host', version: '1.0.0' },
});
const activities = [];
const { message, provenance, usage } = await agent.run({
  key: 'page-42:main',
  instructions: 'You are working on one document with its owner.',
  input: ['<document>…</document>', 'Tighten the second paragraph.'],
  effort: 'low',
  sandbox: { mode: 'workspace-write', cwd: '/srv/site', writableRoots: ['/srv/site/work'], network: true },
  onEvent: event => foldActivity(activities, event),
  timeout: 900_000,
});
```

What it does for every host:

- The sandbox is read-only unless the host passes `sandbox.mode: 'workspace-write'` and
  names the writable folders.
- Approval requests are declined unless the host passes `onApproval`. The sandbox is the
  boundary.
- Raw reasoning is never read or passed on, only the summaries the agent publishes.
- `disableUserExtensions` (on by default) switches off the MCP servers, plugins and apps
  in the user's own Codex configuration for these threads. Pass `false` to leave them on.
- `OPENAI_API_KEY` is removed from the child's environment by default (`dropEnv`), so the
  signed-in account is used.
- `threadConfig` passes any further Codex configuration, for example
  `{ 'features.multi_agent': false }`.
- `model` on a run names a model for that run instead of the provider's default (a
  profile uses this).
- `instructions`, `sandbox.mode` and `threadConfig` take effect when a key's thread
  starts. Later runs on the same key keep them.
- Every agent message but the last is reported as an "Agent note" activity. The last is
  the reply.
- A run past its `timeout` is interrupted and its thread dropped, so the next run on that
  key starts fresh.

### cli-oneshot

One request, one process, one answer. Nothing is remembered between runs.

```js
import { CliOneshotProvider } from '@lyra-forge/leyline/server/providers';

const codex = new CliOneshotProvider({ preset: 'codex', bin: '/usr/local/bin/codex' });
const claude = new CliOneshotProvider({ preset: 'claude', model: 'claude-opus-5-5' });
const custom = new CliOneshotProvider({ preset: 'command', command: ['/usr/bin/my-agent', '--json'] });

const { message, data } = await claude.run({
  instructions: 'Return JSON only: {"summary": "…"}',
  input: JSON.stringify(context),
  cwd: '/srv/site',
  json: true,          // also parse the answer; fenced or wrapped JSON is accepted
  signal, timeout: 300_000,
});
```

- `codex` runs `codex exec` in an empty temporary folder with a read-only sandbox, no
  shell tool, no web search, no plugins, apps or hooks, and the user's config and rules
  ignored. It checks `codex login status` first. `bin` must be an absolute path.
  `outputSchema` is passed as `--output-schema`.
- `claude` runs `claude -p` in `cwd` with only the Read, Grep and Glob tools, no MCP
  servers, no user settings or hooks, and no saved session.
- `command` runs the host's own command with the prompt on stdin and reads the answer
  from stdout. No flags are added; what that command may do is the host's decision.
- The child sees a short allowlist of environment variables (`ENV_KEYS`), not the host's
  environment. Add names with `envKeys`.

`runProcess` and `parseJsonAnswer` are exported for hosts that want them alone.

### http-chat

A model reached over HTTP. It needs no vendor program on the machine, so it is how a host
uses other models: a hosted API, a local server, or a proxy in front of several.

```js
import { HttpChatProvider } from '@lyra-forge/leyline/server/providers';

// OpenAI Chat Completions wire: POST {baseUrl}/chat/completions
const local = new HttpChatProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.3' });

// Anthropic Messages wire: POST {baseUrl}/messages
const claude = new HttpChatProvider({
  wire: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-opus-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY',
});

const { message, usage } = await claude.run({
  key: 'thread-7:main',                 // the provider keeps this exchange in memory
  instructions: 'You are a drafting partner.',
  input: 'Shorten the first post.',
  onText: piece => process.stdout.write(piece),
  signal,
});

// Or send the whole exchange yourself; nothing is remembered:
await local.run({ messages: [{ role: 'user', content: 'Hello' }] });
```

- `apiKeyEnv` is the **name** of an environment variable. The key is read at the moment
  of each request and is never stored on the provider, returned, or put in an error.
- `auth` says how the key is sent: `bearer` (default for the OpenAI wire) or `x-api-key`
  (default for the Anthropic wire).
- Replies stream by default (`stream: false` for a whole answer). `usage` is reported
  when the endpoint sends token counts.
- No sampling parameters are sent. `body` merges extra fields into the request if your
  endpoint needs them. On the Anthropic wire `max_tokens` defaults to 16000 and the
  `anthropic-version` header to `2026-10-21` (`anthropicVersion` changes it).
- A reply the model declines (`stop_reason: "refusal"`) is an error, not an empty answer.
- **Text only.** There is no tool loop: the model can read only what the host puts in the
  messages and cannot act. Giving it the host's command table as tools is not built.
- Memory under a `key` lives in the process and is lost on restart. `maxHistory` caps it
  (40 messages by default).

This adapter is tested against a local HTTP server that imitates both wires. It has not
been run against a real provider.

## Conversations

The turn store that Copycat and Skein each wrote. Conversations are keyed by a host
string. The host supplies `run`; the store does the rest.

```js
import { createConversationStore } from '@lyra-forge/leyline/server/conversations';

const store = createConversationStore({
  dir: '/var/lib/myhost/chats',
  maxLanes: 4,
  async run(turn, lane, signal, tools) {
    // lane.id is `${key}:main` for the main lane, or `${key}:<8 characters>` for a side lane.
    const result = await agent.run({
      key: lane.id, input: tools.payload.prompt, signal,
      onEvent: tools.activity,                      // folded into turn.activities and saved
    });
    return { message: result.message, provenance: result.provenance, usage: result.usage };
  },
  onLaneClosed: lane => { if (!lane.main) agent.reset(lane.id); },
  describeFailure: error => error.code === 'timeout' ? 'It ran out of time.' : 'The agent could not finish.',
});

const turn = await store.send('page-42', { user: 'Tighten this', mode: 'fast', payload: { prompt } });
await store.stop('page-42', turn.id);
await store.reset('page-42');             // archives the old turns first
```

- A turn is `{ id, user, status, createdAt, startedAt, finishedAt, message, activities,
  lane, …your fields }`. Status goes `queued` → `running` → `succeeded`, `failed` or
  `stopped`.
- Whatever `run` returns is merged into the turn. `payload` is handed to `run` and never
  written to disk: put the prompt there, not on the turn.
- **Lanes.** The first request to start takes the main lane, whose id never changes, so
  an agent keyed by it keeps its memory. A request that starts while the main lane is
  busy gets a side lane with a fresh id: a fresh agent. `maxLanes` caps how many run at
  once per conversation; the rest wait in order. `maxLanes: 1` is a strict queue.
- **Storage.** One JSON file per conversation, mode 0600, in a 0700 folder. Each write
  goes to a temporary file that is renamed into place. A key that is not plainly safe as
  a file name is stored under a hash of it.
- **Recovery.** A turn left `running` or `queued` by a process that died is marked
  `failed` when the conversation is next opened, with a message asking the person to
  send it again.
- **Stop.** A waiting request is removed. A running one has its `signal` aborted and is
  recorded as `stopped` even if `run` ignores the signal.
- `reset` copies the old turns to `archive/` and refuses while anything is running.
- `store.running(laneId)` returns the turn at work in a lane. A host's command route
  uses it to find which turn an agent's command belongs to.
- All wording can be replaced through `messages`. `stopped`, `removed` and `interrupted`
  may each be a function of the turn, for a host with more than one kind of request.

## Commands

For an agent that has a shell: the host starts a loopback endpoint and leaves a private
session file; the agent runs the host's small CLI, which reads that file and calls back.

Host side:

```js
import { createCommandEndpoint, writeSession } from '@lyra-forge/leyline/server/commands';

const commands = createCommandEndpoint({
  port,                                           // the port your http server listens on
  operations: {
    show: async data => ({ files: await draftFor(data.page) }),
    edit: async data => ({ results: await applyEdits(data.page, data.edits) }),
  },
});
await writeSession({ app: 'myhost', name: `agent-${port}`, url: `http://127.0.0.1:${port}`, key: commands.key });

http.createServer(async (req, res) => {
  if (await commands.handle(req, res)) return;    // POST /agent/<operation>
  // … the rest of your server
});
```

Agent side, in the host's own CLI script:

```js
#!/usr/bin/env node
import { call, readStdin } from '@lyra-forge/leyline/server/commands';

const [port, operation] = process.argv.slice(2);
const data = operation === 'edit' ? JSON.parse(await readStdin()) : {};
try { console.log(JSON.stringify(await call({ app: 'myhost', name: `agent-${port}`, operation, data }), null, 2)); }
catch (error) { console.error(error.message); process.exit(1); }
```

A request is accepted only when all of these hold: it comes from a loopback address; its
`Host` header names this server on a loopback name; it carries no `Origin` header; and
its bearer key matches, compared in constant time. Anything else gets the same plain 404
as an unknown path. The session file is `<state dir>/<app>/<name>.json` (the state
directory is `$XDG_STATE_HOME` or `~/.local/state`), mode 0600, replaced by rename.
`call()` refuses to send the key anywhere but a loopback address.

What this protects against: web pages (which cannot avoid sending `Origin` on such a
request and cannot read the file) and other machines. It does not protect against other
programs run by the same user, which can read the session file just as the agent's
command does. `verifyRequest`, `issueKey` and `sameSecret` are exported for hosts that
keep their own route.

## Routines

Chores written once and run again. `./server/routines` is the storage (unchanged);
`./server/routine-set` is what the hosts built around it.

```js
import { createRoutineSet, headerFormat } from '@lyra-forge/leyline/server/routine-set';

const routines = createRoutineSet({
  shipped: [{ name: 'proofread', title: 'Proofread', description: 'Spelling and grammar.', code: 'Proofread the whole page…' }],
  bankedDir: '/var/lib/myhost/routines',
  engines: ['page'],
});

routines.list({ engine: 'page' });            // banked over shipped of the same name, sorted by title
routines.resolve('/proofread');               // the routine; null for ordinary text; throws for an unknown /name
const request = routines.turnFor(message, { engine: 'page' });
//   '/proofread' -> { user: 'Proofread', prompt: 'Proofread the whole page…', routine: 'proofread' }
//   'make it shorter' -> { user: 'make it shorter', prompt: 'make it shorter' }
await store.send(key, { user: request.user, routine: request.routine, payload: { prompt: request.prompt } });

routines.save('figures', { title: 'Check the figures', prompt: 'Compare every number with the data.' });
routines.remove('figures');                   // moved to archive/, not deleted; a shipped routine it replaced comes back
```

- A routine's `code` is whatever the host runs: a prompt for an agent, or a program. This
  module never runs it.
- `kinds` groups routines for a menu (`byKind()`); `when` and `args` are notes that tell
  an agent when to reach for a routine and what it takes.
- Two file formats: `jsonFormat` (the default) and `headerFormat()`, for routines that are
  code with a comment header (`// routine:`, `// description:`, `// engines:`, `// kind:`,
  `// when:`, `// args:`). Pass `shippedDir` to ship routines as files.

## History

The states a document has been in, one whole snapshot at a time.

```js
import { createHistory } from '@lyra-forge/leyline/server/history';

const history = createHistory({ dir: '/var/lib/myhost/history' });

history.save('page-42', { data: text, label: 'Sent to client', named: true });
history.save('canvas-7', { data: scene, parts: { box1: '…', box2: '…' }, source: 'agent' });   // null when nothing changed
history.list('page-42');                                  // newest first: n, t, source, label, added/updated/removed, keys
const { data } = history.restore('page-42', 3, { current: { data: textNow } });   // put `data` back yourself

history.checkpoint('page-42', turn.id, { data: textNow });               // as a request begins
history.undoRequest('page-42', turn.id, { current: { data: textNow } }); // everything since, undone
```

- `data` is opaque: text or any JSON value. `parts`, when the host can give it, is a map
  of part name to comparable text. It is used to skip no-op saves and to say what each
  version changed.
- Restoring never loses anything: the current state is saved first, and the restore is a
  new version.
- Automatic versions thin as they age (all for a day, hourly for a week, then daily) and
  the oldest go first over `maxBytes`. Named versions, restores, recent request
  checkpoints and the newest version are kept.
- `history.undoRequest` puts the whole document back as it was when the request began,
  **including undoing what people did meanwhile**. To take back only the agent's own
  edits, use `proposals.undoRequest` below.
- The library stores and returns data. Applying a restored state to the document is the
  host's.

## Proposals

A change an agent offers, or makes, to a document people are also editing.

```js
import { createProposals } from '@lyra-forge/leyline/server/proposals';

const proposals = createProposals();          // one built-in kind: find-and-replace on named text files
let doc = { 'content.md': text };             // the host owns the document

// Made at once, for the person to review and undo (the agent's `edit` command):
const made = proposals.make(turn, { file: 'content.md', find: 'in March', replace: 'in April', reason: 'New date' }, doc);
if (made.ok) doc = made.doc; else reply(`not made: ${made.problem}`);

// Or held, for the person to apply:
proposals.offer(turn, edit, { doc });
({ doc } = proposals.apply(turn, 'e0', doc));

({ doc } = proposals.undo(turn, 'e0', doc));              // one edit
({ doc } = proposals.undoRequest(turn, doc));             // a whole request, newest edit first
proposals.report(turns, { [`${turn.id}:e1`]: 'stale' });  // what a browser says became of each edit
proposals.feedback(turn);                                 // lines to tell the agent, each told once
```

- Proposals are recorded on the turn (`turn.proposals`), so the conversation store saves
  them and the panel shows them.
- A proposal's `fate` (`applied`, `stale`, `undone`, `dismissed`) is kept apart from what
  the agent believes. `feedback()` tells the agent once about an edit that did not stay,
  so it neither repeats it nor builds on text that is not there.
- `undoRequest` reverses each edit on its own, so what other people changed stays. An
  edit whose text has since been changed is left in place and returned in `refused`.
- `replay(turns, doc)` gives an agent the reader's copy plus its own edits that no reader
  has reported on yet.
- The text kind refuses an edit unless the text to replace occurs exactly once, so an
  edit cannot land in the wrong place.
- Other kinds: pass `kinds: { text: textEdit, shape: { validate, check, apply, invert, label } }`.
  The document is opaque to everything except the kind.
- Nothing here stores or saves the document, or shows a change to a person.

## Activity

What people did while an agent worked, so it can be told. (The `./activity` entry point,
without `server/`, is the UI's activity transcript: a different thing with an older name.)

```js
import { createActivityFeed, describeEvents, formatActivity } from '@lyra-forge/leyline/server/activity';

const feed = createActivityFeed({
  snapshot: doc => currentParts(doc),                     // the host's: the document now, as comparable data
  diff: (before, after) => changesBetween(before, after), // the host's: [{ id, change: 'added'|'updated'|'removed', before, after }]
});

feed.open('page-42');
feed.touched('page-42');                                  // whenever the document changes
feed.claim('page-42', { kind: 'agent', name: 'Scout' }, ['p3']);   // an agent says what it touched
feed.selected('page-42', tabId, 'Ada', ['p2']);
feed.note('page-42', { actor: { kind: 'person', name: 'Ada' }, text: 'commented on p2' });

const { events, upto } = feed.pending('page-42:main', 'page-42', { mine: actor => actor?.name === 'Scout' });
const block = formatActivity(describeEvents(events, { change: (c, who) => `${who} changed ${c.id}` }));
if (block) { tellTheAgent(block); feed.ack('page-42:main', upto, events); }
```

- A change no agent claimed is a person's. A claim is used once and expires.
- Each reader keeps its own place. A new reader starts at the present.
- Changes by `{ kind: 'system' }` (the host tending the document) are never told.
- What a part is, how two states differ and how a change reads are the host's.
- Nothing is kept on disk.
- This package's Codex adapter cannot add to a running turn, so tell the agent with its
  next command's answer or at the start of its next turn.

## Threads

Comment threads attached to part of a document.

```js
import { createThreadStore } from '@lyra-forge/leyline/server/threads';

const threads = createThreadStore({ dir: '/var/lib/myhost/threads', cleanAnchor: checkMyAnchor });

const thread = threads.create('page-42', { anchor: { file: 'content.md', start: 120, end: 141 }, author: { kind: 'person', name: 'Ada' }, text: 'Is 40 right?' });
threads.reply('page-42', thread.id, { author: { kind: 'person', name: 'Ben' }, text: 'It was 45 last week.' });

await threads.handOff('page-42', thread.id, async ({ prompt }) => {
  const result = await agent.run({ key: `page-42#${thread.id}`, input: prompt });
  return { message: result.message };                     // posted as the agent's reply
}, { where: t => `on “${quoteAt(t.anchor)}”`, agent: 'Scout' });

threads.close('page-42', thread.id, { by: { kind: 'person', name: 'Ada' } });
```

- Anchors are opaque. The host checks them, finds them again when the document changes
  (`reanchor`) and says where one sits (`where`).
- `handOff` gives the agent only what it has not been told, and marks that seen. If the
  run fails, the mark is put back.
- An agent's reply does not reopen a thread a person closed. A person's reply does.
- Storage is one private JSON file per document, or the host's own (`storage`).

## Profiles

Named agents a document can be bound to.

```js
import { createProfiles, createBindings, requestFor, providerFor, conversationKey } from '@lyra-forge/leyline/server/profiles';

const profiles = createProfiles({ dir: '/var/lib/myhost/profiles' });
const bindings = createBindings({ file: '/var/lib/myhost/bindings.json' });

profiles.add({ id: 'kiefer', workdir: '/home/me/agents/kiefer' });   // starts from the folder's AGENTS.md or README.md
bindings.bind('page-42', 'local/kiefer');

const profile = bindings.bound(doc) ? await profiles.get(bindings.bound(doc)) : null;
const provider = providerFor(profile, { codex, http }, codex);
await provider.run(requestFor(profile, { key: conversationKey(lane.id, profile), instructions: hostRules, input, sandbox }));
```

- A profile has a folder of its own (`workdir`), instructions, starting context read
  within a character budget, skills, and optionally a `model` and a `provider` name.
- Context and references must be inside the folder and not hidden. A folder that is a
  home directory or a disk root is refused.
- **A profile grants no writing.** `requestFor` adds instructions and a model and never
  touches the sandbox. Where an agent may write stays the host's decision.
- Problems (a missing file, a path outside the folder) are listed in `profile.problems`,
  not skipped silently.
- Sources: local JSON files, any object with `list()` and `get(id)`, or a program
  (`commandSource`) that answers `list` and `get ID` with JSON.

## Work log and trail

```js
import { createWorkLog, routineStats, suggestRoutines, createTrail } from '@lyra-forge/leyline/server/worklog';

const log = createWorkLog({ file: '/var/lib/myhost/work/log.jsonl' });
log.record({ doc: 'canvas-7', agent: 'Scout', label: 'colour blocked boxes', code, changes: { updated: ids } });
log.record({ doc: 'page-42', agent: 'person', routine: 'proofread' });

routineStats(log.read('30d'), routines.list());      // runs, by people or agents, failures, last used
suggestRoutines(log.read('30d'), { routines: routines.list() });   // hand-written work that repeats

const trail = createTrail({ dir: '/var/lib/myhost/trail' });
trail.record('canvas-7', { source: 'Scout', what: 'tidied arrows', changes: { updated: ['a1', 'a2'] } });
trail.read('canvas-7', lastSeen);                    // "while you were away"
```

- A run is kept when it changed something, failed, or was a routine. Prompts and replies
  are never recorded.
- `suggestRoutines` groups runs by the shape of their code (names, strings and numbers
  aside). It is for hosts whose agents write code; for prompt-driven hosts only the
  statistics and the trail apply.

## Telemetry (optional)

Nothing is sent anywhere unless the host configures it.

`onCall(record)` is a hook the conversation store calls once per finished turn:

```
{ key, lane, turnId, status, startedAt, finishedAt, durationMs,
  provenance?: { provider, model, … }, usage?: { inputTokens, outputTokens, … }, error? }
```

`createOtlpReporter` returns such a hook. It posts one span per turn, as OTLP/HTTP JSON,
to the URL you give it. With no URL it returns a function that does nothing.

```js
import { createOtlpReporter } from '@lyra-forge/leyline/server/telemetry';

const store = createConversationStore({
  dir, run,
  onCall: createOtlpReporter({
    url: process.env.MYHOST_OTLP_TRACES_URL,      // unset: no telemetry
    tokenEnv: 'MYHOST_OTLP_TOKEN',                // the NAME of a variable holding a bearer token
    serviceName: 'myhost',
  }),
});
```

Spans use the OpenTelemetry GenAI attribute names (`gen_ai.operation.name`,
`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, …). An
`http-chat` turn is a `chat` span; an agent program is an `invoke_agent` span. No
request, reply or activity text is sent: only names, times, token counts and status. A
failing endpoint never fails a turn.

## Somm (optional)

[Somm](https://github.com/lavallee/somm) is a Python tool for LLM telemetry and routing.
This package does not import it, depend on it or need it. There are two ways to connect
the two, both configuration only.

**1. Route `http-chat` through a Somm proxy.** `somm serve` exposes
provider-compatible routes. Point the adapter's base URL at it:

```js
const routed = new HttpChatProvider({
  wire: 'anthropic',                        // POST /v1/messages; or 'openai' for /v1/chat/completions
  baseUrl: 'http://127.0.0.1:7878/v1',
  model: 'somm/auto',                       // or 'provider/model', or a bare model name
  apiKeyEnv: 'SOMM_SERVICE_TOKEN',
  auth: 'bearer',                           // Somm wants Authorization: Bearer on both wires
  headers: { 'X-Somm-Workload': 'myhost-chat' },
});
```

**2. Report seat-based agents to Somm.** A proxy cannot see a turn that ran inside the
Codex app-server or a CLI. Send those as spans:

```js
onCall: createOtlpReporter({
  url: 'http://127.0.0.1:7878/api/otlp/v1/traces',
  tokenEnv: 'SOMM_SERVICE_TOKEN',
  filter: record => record.provenance?.provider !== 'http-chat',   // the proxy already recorded those
})
```

Where these details come from, and what is not confirmed:

- The routes `POST /v1/messages`, `POST /v1/chat/completions`, `POST /v1/responses` and
  `/api/otlp/v1/traces`, the port 7878, the model string `somm/auto`, the headers
  `X-Somm-Workload` and `X-Somm-Project`, and the token variable `SOMM_SERVICE_TOKEN`
  are quoted from Somm's README (version 0.29.0).
- That the proxy routes take a bearer token, not `x-api-key`, comes from reading Somm's
  service source, not its README.
- **None of this has been run against a live `somm serve`.** In particular it is not
  confirmed that Somm accepts the spans this package produces, or how it records an
  `invoke_agent` span that carries no cost. `/v1/responses` is not supported by the
  adapter.

## How consumers pin it today

The package is not on npm. Skein and Copycat each keep a packed tarball and a small
provenance file in `vendor/`, and install from the tarball. Skein's
`scripts/update-chat-library.js` does this; the same steps by hand, from a clean
checkout of this repository at the commit you want:

```sh
cd /path/to/leyline
git status --porcelain            # must print nothing: pin a commit, not a working tree
npm test && npm run check
npm pack --pack-destination /path/to/consumer/vendor
```

Then in the consumer:

```sh
npm install ./vendor/lyra-forge-leyline-0.4.1.tgz
```

and write `vendor/leyline.json`:

```json
{
  "name": "@lyra-forge/leyline",
  "version": "0.4.1",
  "source": "<where this repository lives>",
  "revision": "<git rev-parse HEAD>",
  "directory": ".",
  "artifact": "lyra-forge-leyline-0.4.1.tgz",
  "integrity": "sha512-<base64 sha512 of the tarball>"
}
```

Two things change from the 0.2.3 scripts: `--source` points at this repository rather
than at Toucan, and the package is the repository root, so the status check and
`npm pack` run on `.` instead of `packages/agent-chat`. This repository has no remote
yet, so there is no URL to put in `source`.

Never edit a consumer's generated bundle. Change the package here, bump the version,
repack.

## Name

The package is `@lyra-forge/leyline`. It began as `@lyra-forge/agent-chat` (0.2.3 to
0.4.1), named for the first thing it held, the chat panel. A ley line is the unseen line
said to connect separate places; this is the layer running under tools where people and
agents share a document. The export paths did not change with the rename. Server code
reads the name from `package.json` (`server/package-info.mjs`), so telemetry attributes
are now `leyline.turn.id` and so on; anything that read `agent_chat.*` spans must be told.
A test (`test/exports.test.mjs`) fails if a file under `server/`, `src/` or `test/`
contains the package name. A consumer moving from the old name changes the dependency
name in its `package.json`, its import specifiers, its pinned tarball and provenance
file, and its Tailwind source path if that names the package folder.

## Moving a host onto the package

`docs/adopting.md` has the steps for Copycat, Skein and Toucan, module by module.

## Development

```sh
npm test         # node --test; no network, no model calls, no dependencies to install
npm run check    # node --check over every .mjs file
```

Tests drive the adapters with stand-ins: a fake app-server (`test/fixtures/`), fake CLIs
written to a temporary folder, and local HTTP servers. The TSX components are not
compiled or tested here; consumers build them.

## Not done yet

- **Toucan has not adopted the package.** Toucan `main` still runs its own copy of the
  chat panel and its own Codex transport. The UI here is the 0.2.3 extraction and does
  not include Toucan's later changes.
- **One host uses the server modules, on a branch.** Copycat's `adopt-package` branch
  (2026-11-23, not merged at the time of writing) runs on the two agent providers, the
  conversation store, the routine set, proposals and commands; `docs/adopting.md` lists
  what that found. Skein and Toucan still run their own code. History, activity, threads,
  profiles and the work log have no host: they are tested alone and together
  (`test/together.test.mjs`) and will find gaps on first use.
- **Run against a real agent once.** The Codex adapter was checked against the protocol
  types `codex app-server generate-ts` produces (Codex CLI 0.171.0) and a fake server,
  and then, through Copycat, against the signed-in Codex CLI for one short request (a
  turn with activity and one edit). The one-shot presets, `http-chat` and the Somm
  settings have not been run against real agents or endpoints.
- **Server-only consumers still install the UI's dependencies.** The package has one
  dependency list, and React is a required peer. The server modules import none of it.
- **No shared-text or CRDT module.** Each host still keeps its own draft, and Copycat's
  draft sync stays in Copycat.
- **Reflexes, presence, the brief, the review log, plans and references are not here.**
  `docs/patterns.md` says which are host-side by nature and which are candidates.
- **The activity feed cannot reach a running turn** through this package: there is no
  steering, so an agent hears what changed at its next command or turn.
- **History is synchronous** (file reads, writes and compression on the calling thread),
  as in Toucan. Large documents saved often will be felt.
- **`http-chat` has no tools**, so it cannot take the place of an agent that edits
  through commands.
- Approvals can only be answered by a callback, not shown to a person.
- **No TypeScript types** for the server modules; they are documented with JSDoc.
- Tested on Node 24, 25 and 26. Node 22 is the stated minimum and was not available to test on.

## Licence

MIT. See `LICENSE`.
