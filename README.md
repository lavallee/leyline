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
| `./server/providers/acp` | A fourth adapter: any agent that speaks the Agent Client Protocol. 0.6.0. |
| `./server/conversations` | The turn store: queue, lanes, an event log per conversation, recovery, stop, subscribe, asks, steering. 0.3.0; the log and what follows from it, 0.7.0. |
| `./server/events` | The events of a conversation and the one function that applies them, for a server and a browser alike. 0.7.0. |
| `./server/stream` | A conversation as Server-Sent Events that a browser can follow and pick up again. 0.7.0. |
| `./stream-client` | The browser side of that: plain JavaScript on `fetch`, reconnecting and resuming. No React. 0.7.0. |
| `./server/commands` | How an agent with a shell reaches the host: a private key over loopback. 0.3.0. |
| `./server/mcp` | The same operations as a Model Context Protocol server over stdio, for agents that speak MCP. 0.7.0. |
| `./server/telemetry` | An optional hook, and an OTLP reporter that is off unless configured. 0.3.0. |
| `./server/routine-set` | Shipped and banked routines as one set: kinds, slash names, a routine as a request, save, remove. 0.4.0. |
| `./server/history` | Versions of a document: save, list, restore, prune, and a checkpoint per request. 0.4.0. |
| `./server/proposals` | Edits an agent offers or makes: fates, feedback, undo one or a whole request. 0.4.0. |
| `./server/activity` | What people did meanwhile, with a place per reader. 0.4.0. |
| `./server/threads` | Comment threads, and handing one to an agent. 0.4.0. |
| `./server/profiles` | Named agents a document can be bound to. 0.4.0. |
| `./server/worklog` | What agents did: routine statistics, suggestions, and a per-document trail. 0.4.0. |

Each adapter can also be imported alone: `./server/providers/codex-app-server`,
`./server/providers/cli-oneshot`, `./server/providers/http-chat`, `./server/providers/acp`.

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

### The shell: one strip, one set of panels

The package is opinionated at the top and plain underneath: our own tools (Toucan,
Copycat, Skein) use these components rather than keeping their own copies, so they look
and behave alike. `docs/shell.md` has the conventions and the levels a host can stop at.

```tsx
import { AppBar, AppBarButton, AppBarMore } from '@lyra-forge/leyline/app-bar';
import { SidePanel, PanelNotice, PanelError } from '@lyra-forge/leyline/side-panel';
import { HistoryPanel } from '@lyra-forge/leyline/history-panel';
import { RoutineMenu } from '@lyra-forge/leyline/routine-menu';

<AppBar product="toucan" productHref="/" title={title} live={synced}>
  <AppBarButton icon={HistoryIcon} label="History" pressed={historyOpen} onClick={toggleHistory} />
  <RoutineMenu engine="tldraw" loadRoutines={…} runRoutine={…} saveRoutine={…} removeRoutine={…} onAskAgent={ask} />
  <AppBarButton icon={MessageSquareIcon} label="Chat" variant="outline" pressed={chatOpen} onClick={toggleChat} />
</AppBar>
```

Components take the host's data and actions as props and never fetch a URL themselves.
`HistoryPanel` lists what `./server/history` keeps; the host passes `loadVersions`,
`readVersion`, `restoreVersion` and, optionally, `saveVersion`, and shows a version
either with `Preview` (drawn over its stage) or itself from `onPreview`. `RoutineMenu`
groups by the `kinds` its `loadRoutines` returns, searches past six routines, and offers
`loadSuggestions` (what `./server/worklog` noticed) for banking. A host inside a shadow
root passes `container` to `AppBar`; popovers opened from the strip render there.

A page that is not React uses `./shell`: `mountShell(node, props)` draws the strip, the
routine menu and the History panel from plain data (`actions` as `{ id, label, icon, count,
pressed, … }`, `onAction(id)`, `routines`, `history`) and returns `update` and `unmount`.
Copycat's editor works this way.

## Providers

A provider turns one request into one reply, and may report what it is doing on the way.

```
provider.name            'codex-app-server' | 'cli-oneshot' | 'http-chat' | 'acp'
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
- A request the agent makes of the client (an approval, a question) is declined unless
  the run passes `onAsk`; see [Asks](#asks-requests-that-wait-for-a-person). The sandbox
  is the boundary. Approvals are only asked for at all when a run sets `approvalPolicy`.
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
  key starts fresh. `idleTimeout` on a run does the same when the agent has said nothing
  about it for that long; the quiet period is not counted while the agent is waiting for
  an answer to an ask.
- A stop is bounded. If the agent has not confirmed an interrupt within `stopGrace`
  (10 seconds by default) the run ends as `stopped` anyway and its thread is forgotten,
  since nobody knows what state it is in.
- A key is taken from the moment `run()` is called: a second run on it is refused with
  `busy` even while the first is still starting its thread.
- What the child sends is treated as data. A line that is not a JSON object, a
  notification in an unexpected form, or a line over `maxLine` (64 MB) is skipped, never
  thrown. The child's stderr is always drained.
- `close()` sends SIGTERM, then SIGKILL after `killGrace` (2 seconds). With
  `processGroup: true` both go to the child's whole process group.

#### Streaming

The reply arrives as it is written, and so can a command's output:

```js
await agent.run({
  key: 'page-42:main', input: 'Summarise the draft.',
  onText: (piece, { segment }) => preview(piece, segment),   // segment changes when the agent begins another message
  streamOutput: true,                                         // a command's output as `append` events on its activity item
  onEvent: event => foldActivity(activities, event),
});
```

Deltas are gathered for 40 ms or 400 characters before they are passed on
(`streamBatch: { ms, chars }` on the provider; `ms: 0` passes each one straight through),
and always reach the host before any event that followed them. Messages the agent marks
as commentary arrive through `onEvent` as an "Agent note" that grows, not through
`onText`. Without `streamOutput` a command's activity item is what it was before: the
tail of the output when the command ends. `capabilities.textStream` is `true`.

#### Asks: requests that wait for a person

When a run sets an approval policy that asks, Codex sends requests to its client before
it acts. The run's `onAsk` receives each one in a shape that is the same for every
provider, and may take as long as a person does to answer:

```js
await agent.run({
  key: 'page-42:main', input: 'Publish the page.',
  approvalPolicy: 'on-request',                 // default 'never': nothing is asked, what the sandbox forbids fails
  sandbox: { mode: 'workspace-write', cwd: '/srv/site', writableRoots: ['/srv/site/work'] },
  onAsk: async (ask, { signal }) => {
    // ask: { id, kind: 'command', title: 'Run a command', detail: { command, cwd, reason },
    //        options: [{ id: 'accept' }, { id: 'acceptForSession' }, { id: 'decline' }, { id: 'cancel' }] }
    return await showToThePerson(ask, signal);  // 'accept', or { option: 'accept', answers }, …
  },
});
```

Kinds: `command` and `file-change` (approvals), `permissions` (more access for the turn
or the session), `input` (questions from the agent, with `questions`; answer with
`{ option: 'accept', answers: { questionId: text } }`) and `elicitation` (a question from
an MCP server; answer with `{ option: 'accept', content }`). The reply sent to Codex has
the shape its method expects; the table is exported as `CODEX_REQUESTS` and was checked
against the bindings `codex app-server generate-ts` writes for 0.171.0. A throw, no
answer, or an unknown option is a decline. Stopping the run answers what is still open
with `cancel`; a request Codex withdraws aborts `signal` and is not replied to. A method
this client does not know gets a JSON-RPC error instead of an approval-shaped reply.
With a conversation store, pass `onAsk: tools.ask` and the store does the waiting (see
[Conversations](#conversations)).

#### Steering

```js
const running = agent.run({ key: 'page-42:main', input: 'Work through the open comments.' });
await agent.steer('page-42:main', 'The owner just rewrote section 2: read it again before you go on.');
```

`steer` calls Codex's `turn/steer` with the id of the turn that is running
(`expectedTurnId`), so input that arrives as a turn ends is refused by the agent rather
than starting a turn nobody asked for. That refusal, and there being no run for the key,
rejects with a `ProviderError` whose `code` is `'ended'` (status 409): send the text as a
new request instead. A steer sent while the run is still starting waits for the turn.
`capabilities.steer` says whether an adapter can; only this one can.

#### Memory across a restart

Each result's `provenance.threadId` names the agent's thread. Hand it back after a
restart and the thread is taken up again with `thread/resume`:

```js
const next = await agent.run({ key: 'page-42:main', input: 'Carry on.', threadId: saved });
next.provenance.memory;   // 'kept' | 'resumed' | 'new' | 'lost'
```

`'kept'`: the provider already held the thread. `'resumed'`: taken up again from the id.
`'new'`: a first thread. `'lost'`: the id was given but Codex could not resume it, so a
new thread was started and the agent remembers nothing. A thread the provider was told
to forget (`reset(key)`, a run that timed out or would not stop) is never resumed. With
a conversation store, spread `tools.resume` into the run and the store keeps the id.

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

- A run that is stopped, times out or floods its output has its process ended: SIGTERM,
  then SIGKILL after two seconds (`killGrace` on `runProcess`). `processGroup: true`
  signals the CLI's whole process group, so what it started stops with it; it is off by
  default because a child in its own group no longer receives a Ctrl-C typed at the
  host's terminal.
- `run({ json: true, validate })` hands the parsed answer to the host's own check before
  it is returned. Return `false` or a reason, or throw, to fail the run; return an object
  to use a repaired copy. `outputSchema` is enforced by Codex only, so this is where the
  other presets' answers are checked.

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
  (40 messages by default) and `maxKeys` caps how many keys are remembered (1,000; the
  one used longest ago is forgotten first).
- **Timeouts.** `timeout` on a run (5 minutes by default) covers everything, retries
  included. `idleTimeout` on the provider stops a request that has gone quiet: no byte
  for that long, before the first one or between chunks. It is off by default. Node's
  own `fetch` also gives up after 10 seconds connecting and after 5 minutes without
  response headers or without a chunk, whatever these are set to.
- **Retries** are off by default. With `retries: n` a request is sent again, up to `n`
  times, when the endpoint could not be reached or answered 408, 429 or 5xx, and only
  before any part of an answer has arrived. The wait doubles from `retryDelay` (500 ms)
  or follows `Retry-After`, up to 30 seconds, and a stop ends it. The request is a POST
  sent again whole: an endpoint that failed after doing the work may bill for it twice.
- **A stream that stops part-way is an error** (`unavailable`), not a short answer: a
  reply counts only once the endpoint has sent a finish reason or its end marker.
- An answer over `maxResponse` characters (16 million by default) is refused while it
  arrives, as is any single stream event that large.

This adapter is tested against a local HTTP server that imitates both wires. It has not
been run against a real provider.

### acp

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview)
(ACP): Gemini CLI, OpenCode, Goose, and the others on the protocol's agents list. One child
process, one ACP session per key, text and activity streamed while it works. The package
plays the client, the part an editor plays.

Implemented against **ACP protocol version 1**, read on 2026-11-23 from the specification
(`https://agentclientprotocol.com/protocol/v1/` : overview, initialization, session-setup,
prompt-turn, tool-calls, file-system, terminals, authentication, error, transports) and
its JSON Schema, release `schema-v1.35.0`
(`https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json`).
Version 2 was a beta on that date and is not spoken; an agent that answers `initialize`
with any other version is refused with a `ProviderError` that names it.

```js
import { AcpProvider, foldActivity } from '@lyra-forge/leyline/server/providers';   // or .../server/providers/acp

const agent = new AcpProvider({
  command: ['/usr/local/bin/gemini', '--acp'],     // an absolute path, from the host's configuration. `opencode acp`, `goose acp`, …
  workDir: '/var/lib/myhost/agent-work',           // the child's folder, and the default session folder
  clientInfo: { name: 'myhost', title: 'My Host', version: '1.0.0' },
});
const activities = [];
const { message, provenance, usage } = await agent.run({
  key: 'page-42:main',
  instructions: 'You are working on one document with its owner.',
  input: ['<document>…</document>', 'Tighten the second paragraph.'],
  cwd: '/srv/site',                                // the session's folder; applies when the session starts
  sessionId: saved,                                // optional: an id kept from an earlier provenance.sessionId
  onEvent: event => foldActivity(activities, event),
  onText: (piece, { segment }) => preview(piece, segment),
  onDiff: diff => { /* { id, path, oldText, newText, status, … }: see below */ },
  timeout: 900_000, idleTimeout: 120_000,
});
// provenance: { provider: 'acp', agent, agentVersion, model, sessionId, session: 'new' | 'kept' | 'loaded' | 'resumed', protocolVersion: 1, stopReason }
```

How `session/update` becomes the events every provider gives:

| ACP | Here |
| --- | --- |
| `agent_message_chunk` (text) | `onText(piece, { segment })`. The last message of the turn is `message`; an earlier one (before a tool call, or under another `messageId`) becomes an activity titled "Agent note". `reply: 'all'` keeps every message, joined by blank lines. |
| `agent_thought_chunk` | `{ kind: 'reasoning', append, status: 'running' }`, then `status: 'done'` when the agent moves on. |
| `tool_call`, `tool_call_update` | `{ id: toolCallId, kind: 'activity', title, status, toolKind, command?, paths?, text? }`. `pending` and `in_progress` are `running`, `completed` is `done`, `failed` is `failed`. `toolKind` is ACP's kind (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`); `command` is `rawInput.command` of an `execute` call; `paths` are its locations and diff paths; `text` is its text content. |
| tool call content of type `diff` | `onDiff({ id, toolCallId, index, path, oldText, newText, status, title, toolKind, key, sessionId })`, again whenever its text or status changes. |
| `plan` | One activity with id `plan`, titled "Plan", one line per entry (`[ ]`, `[~]`, `[x]`); `done` when every entry is. |
| `usage_update` | `usage.contextTokens`, `usage.contextSize`, `usage.cost`. |
| `session/prompt` result | `end_turn`, `max_tokens`, `max_turn_requests` resolve (`provenance.stopReason` says which); `cancelled` rejects with code `stopped`; `refusal` with `failed`. |
| everything else | Not mapped. `onUpdate(update)` receives every raw update of the turn. |

What the agent may ask of the client, each a hook with a safe default:

| Hook | Serves | Default |
| --- | --- | --- |
| `readFile(path, { key, sessionId, line, limit })` | `fs/read_text_file`. Return the text; return `undefined` to leave the path to the default reader; throw to refuse (the agent sees the message). | Reads only inside `roots` (checked as written and again after links are resolved). With no `roots` and no hook the capability is not advertised. |
| `writeFile(path, content, { key, sessionId })` | `fs/write_text_file`. Throw to refuse. | Refused: without the hook the capability is not advertised. |
| `onPermission(request, { signal })` | `session/request_permission`. May return a promise, so a person can be asked; the idle clock stops while it waits. Return an `optionId`, or a kind (`allow_once`, `allow_always`, `reject_once`, `reject_always`), or `'cancelled'`, or nothing to leave it to the policy. | The `permission` policy: `'deny'` (default) rejects; `'allow-read'` allows once a `read` or `search` call whose locations are all inside the session folder or `roots`. There is no allow-everything policy, and "once" is never widened to "always". |
| `terminal: { create, output, waitForExit, kill, release }` | The five `terminal/*` methods. | Not offered: the capability is advertised only with all five. |

Also:

- **Sessions.** A key keeps its ACP session. `provenance.sessionId` is the agent's id for
  it; pass it back as `sessionId` after a restart and the session is resumed
  (`session/resume`, no replay) or loaded (`session/load`; the replayed history is
  dropped, not taken for a reply) where the agent advertises either. If that fails, or the
  agent can do neither, a new session starts and `provenance.session` is `'new'`, so a
  host can tell memory was lost. After a crashed child the provider tries the same by itself.
- **Instructions** go in `systemPrompt` (mode `append`) when the agent advertises it, and
  otherwise at the head of the first prompt of a new session.
- **MCP servers.** `mcpServers` (on the provider or a run) is passed to `session/new` in
  ACP's shape. `http` and `sse` servers are refused with code `config` unless the agent
  advertises them. Default: none.
- **Authentication.** Nobody is signed in by this adapter. When the agent answers
  `auth_required`, the run rejects with code `auth` and a message naming the method ids
  the agent offered (also on `error.authMethods`). `authMethodId` sends one named
  `agent`-type method to `authenticate` after `initialize`, for a method that needs no
  person; a `terminal` method is never sent.
- **Stopping.** `cancel(key)` and an aborted `signal` send `session/cancel` and answer any
  open permission request `cancelled`; the run rejects with `stopped` and the session
  survives. An agent that does not confirm within `cancelGrace` (10 s) loses its session.
  A run past `timeout`, or silent for `idleTimeout`, is cancelled, rejects with `timeout`,
  and its session is dropped. A dead child rejects what is in flight with `unavailable`;
  the next run starts a new one. Lines on stdout that are not protocol messages are
  skipped and handed to `onNoise`.
- **It is not a sandbox.** An ACP agent runs its own tools in its own process, as the
  user who started it. The hooks decide what it gets *through the client*; its own
  permission mode and `onPermission` decide the rest. Many agents read and write files
  directly and never call `fs/*`. A host that needs a hard boundary runs the command
  inside one.

**Asks, memory, steering.** `onAsk` on a run receives a permission request in the same
shape the Codex adapter uses (kind `permission`, with the agent's own options), after
`onPermission` if that hook leaves it undecided: `'accept'` picks the first allow-once
option and is never widened to "always". `provenance.memory` says `'kept'`, `'resumed'`
(loaded or resumed from a saved id), `'new'` or `'lost'`, beside the older
`provenance.session`. There is no `steer()`: version 1 of the protocol gives a client
nothing to send into a running prompt turn except `session/cancel`, so
`capabilities.steer` is `false`.

#### The live draft, and a write that becomes a proposal

`fs/read_text_file` exists so an agent reads what is in the editor, not what is on disk,
and `fs/write_text_file` so the editor learns of a change. That is the same problem
`./server/commands` solves for an agent with a shell. With the two hooks and
`./server/proposals`, the agent reads the live draft and its write lands as an edit the
person can see and undo:

```js
import { AcpProvider, diffToEdit } from '@lyra-forge/leyline/server/providers/acp';
import { createProposals } from '@lyra-forge/leyline/server/proposals';

const proposals = createProposals();
let doc = { 'content.md': draftText };                    // the host's live draft
const turns = new Map();                                  // conversation key -> the turn in flight
const fileOf = name => name === '/srv/site/content.md' ? 'content.md' : null;

const agent = new AcpProvider({
  command, workDir,
  readFile: name => { const part = fileOf(name); return part ? doc[part] : undefined; },
  writeFile: (name, content, { key }) => {
    const part = fileOf(name);
    if (!part) throw new Error('Only the document can be written.');
    const change = diffToEdit({ path: name, oldText: doc[part], newText: content }, { file: part });
    if (!change.ok) throw new Error(change.problem);                  // the agent is told why
    const made = proposals.make(turns.get(key), { ...change.edit, reason: 'Written by the agent' }, doc);
    if (!made.ok) throw new Error(made.problem);
    doc = made.doc;                                                   // applied, and undoable: proposals.undo(turn, 'e0', doc)
  },
});
```

`proposals.offer` in place of `make` holds the edit for the person instead; the agent's
next read then still shows the old text, so say so in the instructions.

`diffToEdit(diff, { file, current })` turns an ACP diff (`path`, `oldText`, `newText`,
from `onDiff` or built from a write as above) into the text edit of `./server/proposals`:
the smallest run of whole lines that covers the change and occurs exactly once, so it
still applies while a person edits elsewhere. With `current` (the draft) "exactly once" is
judged against the draft. When there is no such edit it returns `{ ok: false, code,
problem }`: `new-file` (no old text), `empty-file`, `no-change`, `not-found` (the draft no
longer has that text), `ambiguous`, `too-large`, `invalid`.

A diff that arrives through `onDiff` reports what the agent is doing with *its own*
tools. With `status: 'pending'` it has usually not been written yet, and the permission
request that follows carries the same diff (`request.diffs`): a host can reject the
request and offer the diff as a proposal instead. With `status: 'completed'` the file on
disk has already changed.

#### Run against real agents

One small session each on 2026-11-24 (`node scripts/acp-real-agent.mjs gemini opencode goose`:
initialize, a new session in an empty temporary folder, the prompt "Reply with the single
word: ready", close), with no file or terminal capability offered:

| Agent | Command | What happened |
| --- | --- | --- |
| OpenCode 2.2.5 | `opencode acp` | Worked. Protocol version 1; one `agent_message_chunk`, reply `ready`; model and token usage reported; advertises `loadSession` and `sessionCapabilities.resume`, `close`. |
| Goose 1.33.1 | `goose acp` | Worked. Protocol version 1; one `agent_message_chunk`, reply `ready`; model and token usage reported; advertises `loadSession` and `sessionCapabilities.close`. |
| Gemini CLI 0.66.0 | `gemini --acp` | **Not signed in on the test machine**, so no model call was made. `initialize` succeeded (protocol version 1, `loadSession`); `session/new` answered `auth_required`, and the run rejected with code `auth` naming `oauth-personal, gemini-api-key, vertex-ai, gateway`. |

Those sessions had no thoughts, tool calls, plans, diffs, permission requests or `fs/*`
calls in them, and no session was loaded or resumed: with real agents those paths are
**untested**. They are covered by the unit tests, against a fake agent
(`test/fixtures/fake-acp-agent.mjs`) written from the specification.

Not implemented: `session/list`, `session/delete`, `session/set_mode`,
`session/set_config_option` (so no choosing a model or a mode: the agent's own default
applies), `logout`, terminal authentication, elicitation, `plan_update` and
`plan_removed`, notices, compaction updates, subagent sessions, `$/cancel_request`,
image, audio and resource prompt content (a prompt is text parts only), structured
output, and any transport but stdio.

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
- **Storage.** Two files per conversation, mode 0600, in a 0700 folder: a snapshot,
  `<name>.json` (`{ key, turns, …, eventSeq }`), and an event log, `<name>.events.jsonl`
  (a header line, then one JSON line per event since the snapshot). An update appends
  lines to the log; it does not rewrite the conversation. Now and then (`compactEvery`
  events, 1,000 by default, or `compactBytes`), and on `close()`, the log is folded into
  a new snapshot, written to a temporary file and renamed into place. A reader takes the
  snapshot and replays the events numbered after it: `readConversation(dir, key)` does
  that for a tool that looks at the folder without a store. A `<name>.json` written by
  an earlier version is read as it is and gets a log when it next changes. A key that is
  not plainly safe as a file name is stored under a hash of it. Each conversation has
  its own write queue, and writes that pile up behind one in progress are merged into
  one. `fsync: true` flushes each write (see Guarantees and limits).
- **Changing a turn yourself.** The store finds out what changed by comparing each turn
  with what it last recorded, so a host may alter a turn directly. Inside a run, call
  `tools.save()` afterwards. Outside one, the supported way is
  `await store.update(key, turnId, turn => { turn.proposals[1].fate = 'undone'; })`,
  which compares that one turn and resolves when the change is on disk. `store.save(key)`
  still works for a host that changed turns in place: it compares every turn of the
  conversation, so it costs more (about 2 ms against 0.2 ms for 200 turns, in
  `bench/RESULTS.md`). A change nobody announced is not lost, but it is only recorded at
  the next compaction or `close()`.
- **Events.** Every change is an event with a sequence number: `turn.created`,
  `turn.status`, `turn.activity`, `turn.text`, `turn.ask`, `turn.steer`,
  `turn.proposals`, `turn.finished`, `turn.patch`, `conversation.patch`, `reset`. They
  all carry the same few fields (`set`, `unset`, `append`, `activities`) and one function,
  `applyEvent` from `./server/events`, applies any of them to a copy. Activity and reply
  text that arrive in a burst are gathered into one event every `coalesce` milliseconds
  (50 by default), sooner once `coalesceChars` (4,000) have arrived.
- **The reply as it arrives.** `tools.text(piece, { segment })` keeps `turn.preview` while
  the turn runs; it is removed when the turn finishes and `message` holds the reply. Pass
  it to a provider as `onText`.
- **A file that cannot be used is never written over.** One that does not parse, is not
  a conversation, or holds another key is renamed to `<name>.corrupt-<time>` (or
  `.foreign-<time>`) and reported through `onError` with `code: 'corrupt'` and the new
  path in `file`; the conversation then starts empty. One that cannot be read at all (a
  permission or I/O error) fails `open()` with `code: 'unreadable'`, changes nothing, and
  is tried again on the next call.
- **Recovery.** A turn left `running` or `queued` by a process that died is marked
  `failed` when the conversation is next opened, with a message asking the person to
  send it again; an ask it left waiting is marked `cancelled`. A last log line the dying
  process did not finish is left out and cut off. A log that is damaged in the middle, or
  belongs to another conversation or to a snapshot that is gone, is moved aside
  (`.corrupt-<time>`, `.foreign-<time>`) and reported; what could be replayed before the
  damage is kept.
- **Stop.** A waiting request is removed, including one still being written by `send`. A
  running one has its `signal` aborted and is recorded as `stopped` even if `run`
  ignores the signal; that record waits for `run` to return unless `stopGrace` is set,
  after which the lane is freed and whatever the run does later is dropped.
- **Sending twice.** `send(key, { requestId, … })` returns the turn an earlier send with
  the same `requestId` made, in this process or after a restart, so a browser's retry
  does not run a request a second time.
- `reset` copies the old turns to `archive/` and refuses while anything is running,
  waiting or on its way in. A send that arrives during a reset joins the new conversation.
- `close()` stops everything, writes it, folds each log into its snapshot (so the
  `.json` files alone hold everything while the host is down), and after that the store
  takes no more requests (`send` is refused with `code: 'closed'`) and writes nothing.
- **Memory.** A conversation stays in memory once opened. `unload(key)` drops an idle one
  and `evictAfter` does so by itself after a quiet period. Leave `evictAfter` unset if the
  host keeps conversation objects: after an eviction `open()` returns a new one.
- `store.running(laneId)` returns the turn at work in a lane. A host's command route
  uses it to find which turn an agent's command belongs to.
- All wording can be replaced through `messages`. `stopped`, `removed` and `interrupted`
  may each be a function of the turn, for a host with more than one kind of request.

### Subscribing

```js
const { cursor, conversation } = await store.snapshot('page-42');    // a copy, and the position it corresponds to
const stop = store.subscribe('page-42', { after: cursor }, (event, at) => {
  if (event.type === 'gap') return reload();     // the position is no longer held: take snapshot() again
  if (event.type === 'closed') return;           // the store closed, or dropped the conversation from memory
  applyEvent(conversation, event);               // at.cursor is the position after this event
});
await stop.ready;                                // everything after `cursor` has been delivered; live from here
stop();
```

A position is `"<epoch>:<seq>"`. The epoch names one loading of the conversation by one
process: sequence numbers handed out before a restart may never have reached the disk,
so a cursor from before one is answered with a `gap`, as is one older than the store
keeps in memory (`keepEvents`, 2,000 events, or `keepBytes`, 4 MB, per conversation).
Listeners are called synchronously, in order; one that throws is reported through
`onError` and the others still hear. `{ raw: true }` delivers each event as its JSON text.

### Asks

A provider's question for a person, held on the turn until someone answers it:

```js
const store = createConversationStore({
  dir, onAsk: (ask, turn) => ask.kind === 'command' && isHarmless(ask.detail.command) ? 'accept' : undefined,
  async run(turn, lane, signal, tools) {
    return agent.run({ key: lane.id, input: tools.payload.prompt, approvalPolicy: 'on-request', onAsk: tools.ask, onEvent: tools.activity, signal });
  },
});
// The browser sees turn.asks: [{ id, kind, title, detail, options, status: 'pending', askedAt }] and the person chooses:
await store.answer('page-42', turnId, askId, 'accept');
```

The store's `onAsk` is the policy: it may answer at once by returning an answer, or
return nothing to leave the ask `pending` for `store.answer()`. **Its default answers
`'decline'` at once**, so a host that does nothing about asks never has a turn waiting
on one. A pending ask that nobody answers within `askTimeout` (5 minutes; a provider
may give one ask less) is declined and marked `expired`; one still open when the turn
stops or ends is marked `cancelled`. `answer()` rejects with `code: 'answered'` (409)
for an ask that is no longer waiting. The option chosen is kept on the ask
(`ask.answer`); anything a person typed in reply is passed to the agent and never stored.

### Steering

```js
const store = createConversationStore({ dir, run, steer: (input, turn, lane) => agent.steer(lane.id, input) });
const { steered, reason } = await store.steer('page-42', turnId, 'Use the second draft instead.');
if (!steered && reason === 'ended') await store.send('page-42', { user: 'Use the second draft instead.', payload });
```

A steer the agent took is recorded on the turn (`turn.steers: [{ id, text, at }]`, a
`turn.steer` event). `reason` is `'ended'` when the turn has finished, even a moment ago
(the provider's own check makes that safe: see [Steering](#steering) under
codex-app-server); `'waiting'` when it has not started; `'unsupported'` when nothing
says how to steer the run. A run may say so itself with `tools.steering(fn)` instead of
the store's `steer` option.

### The agent's memory across a restart

Each successful turn on the main lane leaves the id of the agent's thread or session
with the conversation (`conversation.memory.main`, taken from `provenance`), and the
next run is handed it as `tools.resume`:

```js
async run(turn, lane, signal, tools) {
  const result = await agent.run({ key: lane.id, input: tools.payload.prompt, ...tools.resume, signal });
  return { message: result.message, provenance: result.provenance };   // provenance.memory: 'kept' | 'resumed' | 'new' | 'lost'
}
```

`tools.resume` is `{ threadId }` for a Codex thread, `{ sessionId }` for an ACP session,
and `{}` when there is none or the lane is a side lane. `reset()` forgets it, as does
`store.forget(key)`; the provider's own `reset(key)` is the host's to call. A turn that
was running when the process died is still marked failed: what survives is what the
agent remembers of the turns before it.

## Streaming a conversation to a browser

Instead of polling, a browser follows the conversation as Server-Sent Events and picks
it up again after a dropped connection or a reload. Server:

```js
import { streamConversation } from '@lyra-forge/leyline/server/stream';

http.createServer(async (req, res) => {
  if (req.method === 'GET' && url.pathname === '/chat/stream') {
    if (!mayRead(req)) return refuse(res);                     // who may read is the host's to decide, before this
    return void streamConversation(store, keyFor(req), req, res);
  }
});
```

Browser:

```js
import { followConversation } from '@lyra-forge/leyline/stream-client';

const feed = followConversation('/chat/stream?page=42', {
  onChange: (conversation, event) => render(conversation),     // the copy, after every change
  onGap: reason => {},                                         // the copy was replaced: 'gap', 'lag' or 'mismatch'
});
feed.state; feed.cursor; feed.close();
```

What goes over the wire: first a `snapshot` event with the whole conversation, then one
event per change, each with `id: <cursor>`. A client that reconnects sends the last id it
applied in `Last-Event-ID` and receives exactly the events after it; when that position
is no longer held it receives a fresh snapshot instead (`reason: 'gap'`). A comment line
is sent every `heartbeat` (15 seconds) of silence. A client that falls more than
`maxBuffered` bytes behind (1 MB) stops being queued for, and gets a snapshot when it
has caught up (`reason: 'lag'`): memory held for one client is bounded by that and by
the size of one snapshot. When the client goes away the subscription and the timer go
with it. `shape` trims what a snapshot shows a browser; events are sent as recorded, so
keep what a browser must not see off the turn (that is what `payload` is for).

The client is plain JavaScript on `fetch` with a readable body (every current browser,
and Node 22), with no dependency and no React. It applies events with the same reducer
the server uses, reconnects after `minDelay` (500 ms), doubling to `maxDelay` (15 s)
with some spread, and treats `silence` (45 s) without a byte as a dead connection. The
native `EventSource` works against the same endpoint too, since it sends
`Last-Event-ID` itself; it only lacks the backoff and the reducer.

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

A body over `maxBody` is answered with 413 (from its declared length when there is one,
before any of it is read) and one that stops arriving with 408 after `bodyTimeout`
(30 seconds); both close the connection. The checks run before the body is read, so only
a caller with the key can send one at all. `endpoint.rotate()` replaces the key without a
restart: the old one stops working at once, and the host writes the session file again.

What this protects against: web pages (which cannot avoid sending `Origin` on such a
request and cannot read the file) and other machines. It does not protect against other
programs run by the same user, which can read the session file just as the agent's
command does. `verifyRequest`, `issueKey` and `sameSecret` are exported for hosts that
keep their own route.

### As an MCP server

An agent that speaks the Model Context Protocol can be given the same operations as
tools, without the CLI. MCP servers on stdio are child processes of the agent, so the
host ships a script of a few lines that the agent starts, and the script passes each
call on to the host over loopback with the session key, as the CLI does:

```js
#!/usr/bin/env node
import { serveMcpBridge } from '@lyra-forge/leyline/server/mcp';

const served = serveMcpBridge({
  app: 'myhost', name: `agent-${process.env.MYHOST_PORT}`,
  defaults: { page: process.env.MYHOST_PAGE },               // added to every call's data
  tools: [
    { name: 'show', description: 'The draft as it is now.', inputSchema: { type: 'object', properties: {} } },
    { name: 'edit', description: 'Replace text in the draft.', inputSchema: { type: 'object', required: ['edits'], properties: { edits: { type: 'array' } } } },
  ],
});
served.done.then(() => process.exit(0));
```

Name that script as an MCP server where the agent takes them: for Codex,
`threadConfig: { mcp_servers: { myhost: { command: process.execPath, args: [script], env: { MYHOST_PORT, MYHOST_PAGE } } } }`;
for an ACP agent, `mcpServers` on the provider or the run. A process that holds the
operations itself uses `serveMcp({ tools, call })` instead of the bridge.

What a tool returns is the result (text as it is, anything else as JSON, an object also
as `structuredContent`); what it throws, or what the host refuses, comes back as a
failed call with the message as its text (`isError`), which the agent can read. The
server speaks the handshake of MCP 2025-11-25 and earlier (`initialize`, `ping`,
`tools/list`, `tools/call`) and the 2026-07-28 revision (`server/discover`, the protocol
version named on each request). It was run under a real client once, the Codex CLI's
(`scripts/mcp-real-check.mjs`; that client speaks 2025-06-18); the 2026-07-28 shapes
follow the specification as read and are covered by this package's tests only. There
are no resources, prompts, sampling or HTTP transport, and the checks on the loopback
endpoint are unchanged: the bridge is one more program holding the same key.

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

profiles.add({ id: 'editor', workdir: '/home/me/agents/editor' });   // starts from the folder's AGENTS.md or README.md
bindings.bind('page-42', 'local/editor');

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

## Guarantees and limits

What the server modules promise, and what they do not. The tests named are in `test/`.

**Durability.**

- A file that is written whole (a conversation's snapshot, a history index, a threads
  file) goes to a temporary file and is renamed into place, so a reader, or a process
  that starts after a crash, sees the old file or the new one and never part of either.
- A conversation's log is appended to. A process that dies in the middle of an append
  leaves at worst one unfinished last line, which every reader leaves out and the next
  store to open the conversation cuts off; whole lines before it are kept. A snapshot is
  written before the log it replaces is started again, and a reader skips events the
  snapshot already holds, so a crash between the two loses nothing and repeats nothing.
  `npm run soak` kills a process that is using the store over and over, in appends and
  in compactions, leaves half-written lines on logs, and checks that every conversation
  reads back whole with everything the store had reported written.
- If the process dies, what is lost is what had not been written yet: activity from the
  last `saveDelay` (600 ms by default) and, for turns that were running or waiting, the
  work itself; those turns are marked failed on the next open. A turn's final status is
  written before `onCall` is called, and `send()` resolves only once the request is on disk.
- If the machine loses power, a file renamed a moment earlier can come back empty or
  old, and lines appended a moment earlier can be missing, because nothing is flushed by
  default. `fsync: true` (conversation store, history, threads) flushes a whole file
  before the rename and the folder after it, and a log after each append. It is slower,
  and off unless asked for. The work log and trail append one line per write and never flush.
- A file that will not parse is moved aside and reported, never overwritten or deleted
  (conversation snapshots and logs, history indexes, thread files). Routine and profile files that will not
  parse are left where they are and left out of the list.
- **An older version reading a newer folder** sees each conversation as of its last
  snapshot: 0.6.0 and earlier do not read the log. After a clean `close()` the snapshots
  hold everything, so going back a version then loses nothing; after a crash it would
  lose what is only in the logs.
- **One process per folder.** Nothing is locked. Two processes writing the same
  conversation folder interleave their logs and overwrite each other's snapshots. History is
  the exception only in that it notices what another process wrote.

**Ordering.**

- Requests to one conversation start in the order they were sent. With `maxLanes: 1`
  they also finish in that order; with more lanes they run side by side and finish when
  they finish.
- The main lane holds one turn at a time. A conversation is busy from the moment a
  request is accepted until its turn has its final status.
- A conversation's events are numbered from 1 with no gaps, in the order the changes
  were recorded, and a subscriber receives them in that order, each once. A position is
  good only within the epoch it came from (one loading of the conversation by one
  process): after a restart, or when the position is older than the store keeps, the
  subscriber is told there is a gap and takes a snapshot, never a silent hole. A copy
  made from a snapshot and the events after it equals the store's state at that
  position; `test/stream.test.mjs` checks this under random disconnects, slow readers
  and server restarts, and the soak checks it across resumed subscriptions.
- What subscribers are told can run ahead of the disk by up to `saveDelay` for activity
  and reply text. Status changes, asks, steers and results are written as they happen.
- Activity events are folded in the order the provider delivers them. An activity feed
  gives each reader events in the order they happened, each once, as long as the reader
  asks before `keep` newer ones have arrived.

**Memory.** Bounded by default: activities per turn (200) and their text (20,000
characters each), turns per conversation (200), events per document in an activity feed
(1,000), messages per thread (500), one line from an agent process (64 MB), a one-shot
agent's output (4 MB), a model's reply over HTTP (16 million characters), remembered
HTTP conversations (1,000 keys of 40 messages), a command request's body (2 MB), a work
log or trail (two files of 8 MB), the recent events a store keeps per conversation for
subscribers (2,000 events or 4 MB), what waits unsent for one stream client (1 MB, or
one snapshot if that is larger), a turn's `preview` (200,000 characters), one line sent
to the MCP server (8 MB). Not bounded unless the host does something: the
conversations a store has open (`unload`, `evictAfter`), the documents and readers an
activity feed knows (`drop`, `forget`), a turn's `message` and the host's own fields, the
`archive/` folders that resets and removed routines fill, and files moved aside as corrupt.

**Timeouts and stopping.**

| | Overall | Quiet period | Stop |
| --- | --- | --- | --- |
| codex-app-server | `timeout`, 15 minutes | `idleTimeout`, off; paused while an ask waits | interrupt, then `stopGrace` (10 s) and the run ends regardless; open asks are answered `cancel` |
| cli-oneshot | `timeout`, 5 minutes | none | SIGTERM, then SIGKILL after 2 s |
| http-chat | `timeout`, 5 minutes | `idleTimeout`, off | the request is aborted at once |
| acp | `timeout`, 15 minutes | `idleTimeout`, off; paused while a hook or an ask is answered | `session/cancel`, then `cancelGrace` (10 s) |
| conversation store | none of its own | none; an ask waits `askTimeout` (5 minutes), then is declined | the signal is aborted and open asks are cancelled; `stopGrace` (off) frees the lane if `run` never returns |

When the host process exits normally its agent children are sent SIGTERM. A host that is
itself killed runs no code: its children then see only their stdin close.

**Untrusted input.** Agent and model output is parsed as data and checked before use:
JSON-RPC lines, stream events, structured answers (`validate`), proposal edits. A text
edit's search takes time proportional to the document plus the text sought, whatever
either contains. Keys and names a host or a model supplies never become paths: they are
used as file names only when plainly safe, and hashed otherwise.

**Asks and steering.** An ask is answered exactly once: by the store's policy, by
`answer()`, by its time limit, or by the end of the turn, whichever comes first; later
answers are refused. The default policy declines. A steer is addressed to the turn that
was running when it was sent; one that arrives as the turn ends is refused by the agent
and reported as `ended`, and a steer is recorded on the turn only after the agent took
it. Neither is promised to survive a restart: a turn that was running is failed on the
next open and its open asks cancelled.

**Errors.** Each module raises its own error type with a stable `code` and a message fit
to show: `ProviderError`, `RpcError`, `ConversationError`, `ProposalError`,
`RoutineError`, `ThreadError`, `ProfileError`. Callbacks a host supplies (`onEvent`,
`onText`, `onAsk`, `onError`, `onCall`, `onApproval`, `onStderr`, subscribe listeners,
the stream client's `onChange` and the rest) may throw without breaking anything. No
module calls `process.exit`.

**Not promised.** That a turn interrupted by a restart continues: the agent's memory of
earlier turns can be resumed, the interrupted turn itself cannot. That the agent's own
record of a thread or session still exists when it is asked for (`provenance.memory`
then says `'lost'`). That a browser sees every intermediate state: bursts are gathered
into fewer events, and a client that lags or reconnects late gets a snapshot. Exactly-once delivery to an agent (a request interrupted by a crash is
marked failed and can be sent again; with a `requestId` it is not run twice by a retry of
the same send). That a child's own children are stopped, unless `processGroup` is set.
Protection from other programs run by the same user. Anything at all about two hosts
sharing one state folder.

## Development

```sh
npm test         # node --test; no network, no model calls, no dependencies to install
npm run check    # node --check over every .mjs file
npm run bench    # a table of times and peak memory; bench/RESULTS.md has the last one
npm run soak     # the conversation store, killed and reopened for 30 s (SOAK_SECONDS)

node scripts/codex-real-check.mjs   # the store and the Codex adapter against the signed-in CLI: small model calls
node scripts/mcp-real-check.mjs     # ./server/mcp under the Codex CLI's MCP client: no model call
node scripts/acp-real-agent.mjs     # one small session per installed ACP agent
```

Tests drive the adapters with stand-ins: a fake app-server and a fake ACP agent
(`test/fixtures/`), fake CLIs written to a temporary folder, and local HTTP servers. The
three scripts under `scripts/` are not part of `npm test`; what each observed when it was
last run is in the changelog. The TSX components are not
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
- **Run against real agents a few times, not for long.** The Codex adapter was checked
  against the protocol types `codex app-server generate-ts` produces (Codex CLI 0.171.0)
  and a fake server; through Copycat, against the signed-in CLI for one short request;
  and with `scripts/codex-real-check.mjs` on 2026-11-24 for streaming, one steer, one
  approval and one resume after a restart (the changelog has what was seen). Of the ask
  kinds only a command approval has been seen from a real agent: file-change approvals,
  permission requests, user-input questions and MCP elicitations are answered in the
  shapes the bindings give and tested against the fake only. The one-shot presets,
  `http-chat` and the Somm settings have not been run against real agents or endpoints.
- **No host uses the 0.7.0 additions yet.** Copycat still polls and Toucan still runs
  its own transport; `docs/adopting.md` says how each would move. The stream helper and
  client have been driven by tests and a fuzz, not by a browser.
- **An interrupted turn cannot be continued.** After a restart the agent's memory of the
  earlier turns is resumed, but the turn that was running is marked failed and must be
  sent again.
- **The event stream is Leyline's own.** It is not AG-UI or the AI SDK's stream format;
  a mapper from `./server/events` to either was left until a host asks.
- **The MCP server is tools only**, over stdio, with the whole list as one page.
- **Server-only consumers still install the UI's dependencies.** The package has one
  dependency list, and React is a required peer. The server modules import none of it.
- **The ACP adapter has met real agents once, briefly.** One one-word session each with
  OpenCode and Goose; Gemini CLI was not signed in. Tool calls, permissions, `fs/*`, diffs
  and session loading are tested only against a fake agent. See [acp](#acp) for what the
  adapter does not implement, and note that it cannot confine an agent.
- **No shared-text or CRDT module.** Each host still keeps its own draft, and Copycat's
  draft sync stays in Copycat.
- **Reflexes, presence, the brief, the review log, plans and references are not here.**
  `docs/patterns.md` says which are host-side by nature and which are candidates.
- **Nothing connects the activity feed to steering.** `store.steer()` can now reach a
  running turn, but deciding when what people did meanwhile is worth interrupting an
  agent for, and saying so, is still the host's (Toucan does it; see `docs/adopting.md`).
- **History is synchronous** (file reads, writes and compression on the calling thread),
  as in Toucan. Large documents saved often will be felt.
- **Opening a conversation and `store.save(key)` still read all of it.** An update no
  longer rewrites the conversation, but opening one parses the snapshot and replays the
  log, and `save(key)` compares every turn (`bench/RESULTS.md`). There is no paging of
  old turns, to disk or to a browser, and a full conversation (`maxTurns`) is still a
  hard stop.
- **`http-chat` has no tools**, so it cannot take the place of an agent that edits
  through commands.
- **No TypeScript types** for the server modules; they are documented with JSDoc.
- Tested on Node 24, 25 and 26. Node 22 is the stated minimum and was not available to test on.

## Licence

MIT. See `LICENSE`.
