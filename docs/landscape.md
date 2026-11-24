# Landscape: comparable tooling, and what it means for Leyline

Written 2026-11-23 against Leyline 0.5.0 (commit `ebd389b`). Line numbers refer to that
commit. The question was: which tools do similar work, where is Leyline weaker, where
does it duplicate something it should adopt, and where is it doing something others are
not.

How to read this. Every claim about another tool carries the URL it was read on, the same
day. Claims marked **unverified** come from memory or from a page that could not be read.
Claims about the Codex protocol were checked against the types that the installed
`codex app-server generate-ts` (Codex CLI 0.171.0) produces, which is the same check the
README describes. Nothing here was run: this is a reading of documentation and of
Leyline's source, not a benchmark. "Not described on the page read" means only that; the
tool may do it elsewhere.

## Verdict

Leyline is not a duplicate of anything surveyed. The kits that look closest (Vercel AI
SDK, assistant-ui, CopilotKit, Mastra, LangGraph) are about one person talking to one
agent, or about running the agent itself. The collaboration services (Liveblocks, Velt,
Tiptap, tldraw sync, Yjs) are about several people on one document, with agents added as
another participant. Leyline's own ground is the part between: the bookkeeping for an
agent that edits a document a person is also editing (the proposals ledger with fates,
"what people did meanwhile", undo of one request that leaves other people's work alone,
lanes, routines). Only Tiptap's paid AI Toolkit was found doing something close to the
proposals ledger, and only for Tiptap documents. Where Leyline is behind is plumbing that
every one of the others has settled: a turn's events are not a stream a browser can
subscribe to and resume, the conversation file is rewritten whole on every update, a
restart fails the running turn and forgets the agent's memory, approvals cannot wait for
a person, and a running turn cannot be steered. The Codex protocol Leyline already speaks
offers most of the missing pieces (steering, approval requests, text deltas, thread
resume); the adapter does not use them yet. For reaching more agents, one protocol matters
most: the Agent Client Protocol (ACP), which Claude, Codex, Gemini CLI, Copilot, Cursor,
OpenCode, Goose and about forty others speak directly or through an adapter.

## Comparison

"Lacks" is from Leyline's point of view in the third column and the other tool's in the
fourth.

| Tool | What it is | What it does that Leyline lacks | What Leyline does that it lacks | Source |
| --- | --- | --- | --- | --- |
| Vercel AI SDK (UI) | Chat hooks and a typed stream format for one agent | A stream of typed parts over SSE (`text-delta`, `reasoning-delta`, `tool-input-available`, `tool-approval-request`, `tool-output-available`, `abort`, `finish`); resuming a stream after a reload (`resume`, with Redis and the `resumable-stream` package); tool approval states (`approval-requested`, `output-denied`) | No document, proposals, history or second person. Its own docs say stopping and resuming conflict: closing a tab or `stop()` "only closes the current HTTP connection" and a separate stop endpoint is needed | https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage |
| assistant-ui | React chat components over a store the host owns (`ExternalStoreRuntime`) | Branching, edit and regenerate, paging of old messages (`hasEarlier`, `onLoadEarlier`), a message queue adapter, tool approval controls (`onRespondToToolApproval`), resumable runs (`canResume`, `onResume`) | No server side at all; nothing about documents or edits | https://www.assistant-ui.com/docs/runtimes/custom/external-store |
| CopilotKit and AG-UI | A React kit, and the event protocol between an agent and a UI that came out of it | About 30 named events (`RunStarted`, `TextMessageContent`, `ToolCallArgs`, `StateSnapshot`, `StateDelta` as JSON Patch, `ReasoningMessageContent`, `ActivityDelta`); interrupts as a run outcome with a `resume` array; adapters for LangGraph, Mastra, Pydantic AI, Claude Agent SDK, OpenAI Agents SDK and others | Shared state is agent-and-app state, not a ledger of edits with fates; no undo of one request; no "what people did meanwhile" told to the agent | https://docs.ag-ui.com/concepts/events https://docs.ag-ui.com/introduction https://docs.copilotkit.ai/ |
| Mastra | TypeScript agent and workflow framework | Workflow steps that `suspend()` and `resume()` from a stored snapshot that "persist across deployments and application restarts" | No document model. Agent tool approval in Mastra: **unverified** | https://mastra.ai/docs/workflows/suspend-and-resume |
| LangGraph | Graph runtime with checkpoints | State persisted per thread by a checkpointer (memory, SQLite, Postgres); `interrupt()` pauses and `Command({ resume })` continues, on the same thread id, after a restart | No UI, no document. Its rule that a resumed node "restarts ... from the beginning", so side effects must be idempotent, is a cost Leyline does not have. Time travel and durability modes: **unverified** (the pages read name them without describing them) | https://docs.langchain.com/oss/javascript/langgraph/persistence https://docs.langchain.com/oss/javascript/langgraph/interrupts |
| OpenAI Agents SDK (JS) | Agent loop library | A paused run is a value: `result.interruptions`, `state.approve()` / `state.reject()`, `result.state.toString()` and `RunState.fromString()` to continue in another process | No document. It warns the snapshot is not authenticated and that SDK upgrades can strand old snapshots | https://openai.github.io/openai-agents-js/guides/human-in-the-loop/ |
| Claude Agent SDK | Claude Code as a library (`@anthropic-ai/claude-agent-sdk`) | Sessions on disk (`~/.claude/projects/<cwd>/*.jsonl`) with `resume` and `forkSession`; a permission chain ending in a `canUseTool` callback; file checkpoints with `rewindFiles()` | Checkpoints cover only its own Write, Edit and NotebookEdit tools, not Bash, and know nothing of a person's edits. Leyline's `claude` preset is one-shot and read-only by comparison | https://code.claude.com/docs/en/agent-sdk/sessions.md https://code.claude.com/docs/en/agent-sdk/permissions.md https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md |
| Agent Client Protocol (ACP) | JSON-RPC between an editor and a coding agent, from Zed | One protocol for many agents; `session/update` with `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` (with `diff` content: `path`, `oldText`, `newText`), `plan`; `session/request_permission` with `allow_once`, `allow_always`, `reject_once`, `reject_always`; `session/load` and `session/resume`; the agent reads and writes files **through the client** (`fs/read_text_file`, `fs/write_text_file`) | No steering of a running turn in the pages read; no store, history or proposals: it is a wire, the editor does the rest | https://agentclientprotocol.com/protocol/overview https://agentclientprotocol.com/protocol/prompt-turn https://agentclientprotocol.com/protocol/tool-calls https://agentclientprotocol.com/protocol/session-setup https://agentclientprotocol.com/overview/agents |
| MCP | JSON-RPC between an agent host and tools | A standard way to offer the host's operations as tools; `elicitation/create` (ask the person; answers `accept`, `decline`, `cancel`); SSE event ids and `Last-Event-ID` to resume a dropped stream; experimental tasks (`tasks/get`, `tasks/result`, `tasks/cancel`, status `input_required`) | Not a chat or document layer | https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation https://modelcontextprotocol.io/specification/2025-11-25/basic/transports https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks |
| A2A | Protocol between independent agents (1.0.0) | Tasks with `TASK_STATE_INPUT_REQUIRED`, `SubscribeToTask`, push notifications, Agent Cards | Aimed at agents of different vendors finding each other over a network; nothing for a person and an agent on one document | https://a2a-protocol.org/latest/specification/ |
| Codex app-server | The protocol Leyline's main adapter speaks | Leyline uses a fraction of it. Present in 0.171.0 and unused: `turn/steer`, `thread/resume`, `thread/fork`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, and server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call` | Not applicable | Types generated locally by `codex app-server generate-ts` (0.171.0); https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md |
| Liveblocks | Hosted rooms: presence, comments, text sync, AI copilots | Presence, multi-user sync, a hosted chat with tools and a knowledge base, fallback models | Hosted service. How its agents act in comments and editors: **unverified** (the guide returned an error) | https://liveblocks.io/docs/ready-made-features/ai-copilots |
| Tiptap AI Toolkit | Paid add-on giving an agent tools on a Tiptap document | Review of AI edits as suggestions with `reviewOptions` modes `preview` and `review`, `acceptSuggestion` / `rejectSuggestion`, and feedback for the model (`result.aiFeedback.events`): the nearest thing found to Leyline's proposals | Tiptap documents only, from a private npm registry. The page read does not say what happens when the person edits while suggestions are pending | https://tiptap.dev/docs/content-ai/capabilities/ai-toolkit/overview https://tiptap.dev/docs/content-ai/capabilities/ai-toolkit/guides/review-changes |
| Yjs and Hocuspocus | CRDT and its WebSocket server | Conflict-free merging of concurrent edits, scaling with Redis, webhooks | No agent layer. Persistence hooks and server-side edits: **unverified** on the page read | https://tiptap.dev/docs/hocuspocus/introduction |
| Automerge | Local-first CRDT with full history | Merge without a server; "view old versions, compare versions, create branches" | No agent layer | https://automerge.org/docs/hello/ |
| tldraw sync and agent kit | Canvas sync, and a starter agent for the canvas | One authoritative room per document (`TLSocketRoom`) stored in SQLite, including `node:sqlite`; every agent action checked against a zod schema and corrected by `sanitizeAction()` before it touches the canvas; `agent.schedule()`, `agent.interrupt()`, `agent.cancel()` | The page read does not describe handling of the person's concurrent changes, nor accept and reject | https://tldraw.dev/docs/sync https://tldraw.dev/starter-kits/agent |
| Velt | Collaboration SDK: comments, presence, cursors, Yjs editing | "Agent Comments" and a review workflow of agents and humans | Hosting and pricing not stated on the page read; no proposals ledger described | https://velt.dev/docs/get-started/overview |
| PartyKit, Cloudflare Agents | One stateful server per room on Durable Objects | Per-room SQLite (`this.sql`), state pushed to clients (`setState()`), chat persistence with "reconnect mid-stream" (`AIChatAgent`), recovery hooks (`onFiberRecovered()`) | Cloudflare only. PartyKit's own docs say its hosted platform shut down on 23 October 2026 | https://developers.cloudflare.com/agents/api-reference/agents-api/ https://docs.partykit.io/how-partykit-works/ |
| Temporal | Durable workflows on a separate service | Every state change recorded in an event history and replayed after a failure | Needs a Temporal Service and workers; workflow code must be deterministic. Activity retry semantics: **unverified** | https://docs.temporal.io/workflow-execution |
| Inngest | Durable functions made of memoised steps | A retry repeats only the failed step; `step.waitForEvent()` to pause for a person; self-hosts "as a single binary, with SQLite or Postgres" | A separate server; it warns a step's side effect can land before its result is saved | https://www.inngest.com/docs/learn/how-functions-are-executed |
| Trigger.dev | Background tasks with realtime updates | Subscribe to a run and to typed streams from React (`useRealtimeRun`, `useRealtimeStream`) | Needs its platform (Postgres sync). Waitpoints and stream resume: **unverified** | https://trigger.dev/docs/realtime/overview |
| DBOS | Durable workflows as a library on Postgres | Each step's output checkpointed; "once a step completes and is checkpointed, it is never re-executed" | Postgres only | https://docs.dbos.dev/architecture |
| Restate | Durable execution server, single binary | A journal replayed on failure; per-key single writer (Virtual Objects); request deduplication by idempotency key | A separate server | https://docs.restate.dev/concepts/durable_execution |
| `node:sqlite` | SQLite built into Node | A transactional local store with no dependency: added in 22.5.0, no flag since 22.13.0, release candidate since 25.7.0, synchronous API | Not applicable | https://nodejs.org/api/sqlite.html |
| Durable Streams | Open HTTP protocol for resumable streams, from Electric (MIT) | "Offset-based reads let you resume from any point", with long-poll or SSE for live tailing; one stated use is LLM token streams | A transport only | https://github.com/durable-streams/durable-streams |

### What Leyline does that the others do not

None of the pages read describes these. That is evidence of absence only in those pages.

- **A fate for every edit, kept apart from what the agent believes** (`applied`, `stale`,
  `undone`, `dismissed`), with the agent told once (`server/proposals.mjs`). Tiptap's
  `aiFeedback` is the one near neighbour.
- **Undo one request's edits and leave what people changed since** (`proposals.undoRequest`),
  next to whole-document checkpoints (`history.undoRequest`). The Claude Agent SDK and
  LangGraph offer only the second kind.
- **"What people did meanwhile"**, attributed by claims, with a place per reader
  (`server/activity.mjs`).
- **Lanes**: a second request starts beside a busy one with a fresh agent, instead of
  queueing or being refused (`server/conversations.mjs` lines 141 to 158).
- **Routines with a work log that suggests new ones**, and **profiles**.
- **No dependencies on the server side, and the signed-in CLI as the agent**, so a host
  needs no API key. One caution for the owner: the Agent SDK overview says "Anthropic does
  not allow third party developers to offer claude.ai login or rate limits for their
  products" without approval (https://code.claude.com/docs/en/agent-sdk/overview). Whether
  a local open-source tool that runs the user's own `claude -p` falls under that is not
  settled here; it is the owner's to check before the `claude` preset is promoted.

## Robustness gaps

1. **An unreadable conversation file is silently replaced.** `open()` catches every read
   or parse error and starts empty (`conversations.mjs` line 107); the next write then
   overwrites the file. `files.mjs` `readJson` (line 24) does the safer thing and throws.
   A half-written or hand-edited file costs the whole conversation.
2. **A restart loses the turn and the agent's memory.** Recovery marks a `running` or
   `queued` turn `failed` (`conversations.mjs` lines 108 to 111). The Codex thread ids live
   only in a `Map` (`codex-app-server.mjs` line 51, cleared at 73 and 214), although the id
   is written to `provenance.threadId` on each finished turn (line 205) and Codex has
   `thread/resume`. LangGraph, the OpenAI Agents SDK, the Claude Agent SDK and ACP
   (`session/load`, `session/resume`) all pick a conversation up again after a restart.
3. **Every request from the agent gets an approval-shaped "decline".** The handler at
   `codex-app-server.mjs` lines 64 to 67 answers any server request with
   `{ decision: 'decline' }`. Codex 0.171.0 also sends `item/tool/requestUserInput`
   (expects `{ answers }`), `mcpServer/elicitation/request` (expects `{ action, content }`)
   and `item/tool/call` (expects `{ contentItems, success }`). Those get a reply of the
   wrong shape. `approvalPolicy: 'never'` (line 121) and switched-off extensions make this
   rare today; it stops being rare the moment a host turns approvals on.
4. **An approval cannot wait for a person.** `onApproval` is called synchronously and its
   return value sent at once (line 65). A callback that returns a promise would send `{}`.
   Every tool surveyed that has approvals makes them asynchronous and gives them three
   answers, not two: MCP `accept` / `decline` / `cancel`; Codex `accept`,
   `acceptForSession`, `decline`, `cancel`; ACP adds "always" options.
5. **No steering.** `turn/steer` takes `{ threadId, input, expectedTurnId }` and fails if
   the turn is no longer the active one, which is the guard a host needs. The adapter never
   calls it, so the activity feed can only speak at the next command or turn (README, "Not
   done yet"). This and gap 4 are what keep Toucan off the package (`docs/adopting.md`).
6. **One wall-clock timeout, and it throws the thread away.** `codex-app-server.mjs` line
   135 and `http-chat.mjs` line 124 time the whole run. A long, healthy run is cut; a hung
   one waits the full 15 minutes. On timeout the Codex thread is dropped, so the agent
   forgets the conversation. An idle timeout (no event for N seconds) is the usual answer.
7. **A `run` that never settles holds its lane for good.** `execute` awaits `run`
   (`conversations.mjs` line 168); `stop` only aborts the signal (line 203). The turn is
   recorded `stopped` when `run` returns, not before. The store has no deadline of its own.
8. **Child processes get SIGTERM and nothing more.** `runProcess` (`cli-oneshot.mjs` lines
   31 to 34) and `CodexRpc.close` (`codex-rpc.mjs` line 44) never escalate to SIGKILL and
   do not kill the process group, so a CLI that ignores the signal, or its children, can
   outlive the request.
9. **The JSON-RPC transport fails quietly.** Lines that are not JSON are dropped
   (`codex-rpc.mjs` line 16), writes ignore backpressure and a closed pipe (line 41), and
   stderr is piped (line 14) but only drained if the caller attaches a listener. The
   provider does (line 69); a host using `./server/rpc` alone must know to.
10. **No retry on a busy model.** `http-chat.mjs` `failure()` (lines 153 to 158) turns 429
    and 5xx into `unavailable` and stops. No backoff, no `Retry-After`. Liveblocks lists
    "fallback AI models" as a feature for the same reason.
11. **A repeated send makes a second turn.** `send()` (`conversations.mjs` lines 126 to
    139) takes no request id, so a browser retry after a dropped response runs the request
    twice. Restate deduplicates by idempotency key; Codex's own `turn/steer` carries a
    `clientUserMessageId`.
12. **Structured answers are parsed, not checked.** `parseJsonAnswer`
    (`cli-oneshot.mjs` line 44) returns whatever object it finds; `outputSchema` is
    "advisory" outside Codex. The tldraw kit checks every model action against a schema
    and repairs it before use. Proposals do check their own edits, which is the part that
    matters most; the gap is everything else a host parses.
13. **Writes are atomic but not flushed.** `persist` and `writePrivate` rename a temporary
    file into place (`conversations.mjs` lines 91 and 92, `files.mjs` line 19) without an
    `fsync`. After a power cut the renamed file can be empty. This is inference from how
    file systems behave, not from a source above. Two host processes on one folder would
    also overwrite each other; nothing locks.

What is already sound, measured against the same sources: the command endpoint's loopback,
`Host`, `Origin` and constant-time key checks (`commands.mjs` lines 74 to 81) are what the
MCP transport specification requires of a local HTTP server; environment allowlists for
child processes; keys read by variable name at call time; the read-only default sandbox;
capped output and activity sizes.

## Performance gaps

1. **The whole conversation is rewritten on every update.** `persist` runs
   `JSON.stringify(conversation, null, 2)` (`conversations.mjs` line 88) for each status
   change and, while an agent works, every 600 ms (line 162). The cost grows with the
   conversation: up to 200 turns of up to 200 activities of up to 20,000 characters each
   (`contract.mjs` line 61). The stringify runs on the event loop. Every tool in group 4,
   and Codex and Claude themselves (`*.jsonl` rollouts and sessions), append instead.
2. **One write queue for all conversations.** `writes` is a single promise chain for the
   store (line 76), so a large conversation delays the saves of every other.
3. **Nothing to subscribe to.** The store has no event emitter and no sequence number.
   A host must poll and resend whole turns, or build its own push (Toucan did, over a
   WebSocket). The AI SDK, AG-UI, ACP and MCP all send small typed deltas, and three of
   them define how to resume after a drop (stream id, `Last-Event-ID`, offset).
4. **The reply does not stream from Codex.** `capabilities.textStream` is `false`
   (`codex-app-server.mjs` line 26) and `event()` (lines 163 to 207) ignores
   `item/agentMessage/delta` and `item/commandExecution/outputDelta`. The person sees
   reasoning summaries and finished commands, then the whole answer at once.
5. **Memory is never given back.** Loaded conversations stay in a `Map`
   (`conversations.mjs` line 72); `http-chat` keeps a history per key until `reset`
   (`http-chat.mjs` line 76). Fine for one document, a slow leak for a long-lived server
   with many.
6. **A full conversation is a hard stop.** At `maxTurns` (200) `send()` throws `full`
   (line 129). There is no paging of old turns to the browser either; assistant-ui has
   `hasEarlier` and `onLoadEarlier` for that.
7. **History is synchronous and whole-snapshot** (`history.mjs` line 88, `gzipSync` on the
   calling thread). The README already says so. `worklog.mjs` line 27 reads its whole file
   (up to 8 MB) to answer any query.
8. **The UI.** Messages use `content-visibility: auto` (`src/ui/message-scroller.tsx`),
   which is a reasonable stand-in for virtualisation, and every message is rendered
   (`src/index.tsx` line 99). Bundle size was **not measured**, for Leyline or for the
   kits compared; no claim is made either way. Server-only consumers still install the UI
   dependencies (README).

## Interop: which protocols to speak, and in what order

1. **Finish the Codex app-server protocol.** It is already the main adapter, it is what
   Copycat runs on, and the missing calls are the two that block Toucan. Steering, async
   approvals and user-input requests, text deltas and `thread/resume` are all in the
   0.171.0 types. `item/tool/call` (tools the client supplies) would let a host offer its
   operations as tools instead of through a shell command; whether it is still
   experimental was **not checked**.
2. **Add an ACP client adapter.** This is the single change that most widens "the models
   it works with". The agents page lists Claude Agent and Codex CLI (through adapters),
   Gemini CLI, GitHub Copilot, Cursor, OpenCode, Goose, Cline, Qwen Code, Kiro, Junie and
   more. The shapes map closely onto the provider contract: `session/new` is a key,
   `session/prompt` is `run`, `session/update` chunks are `onText` and activity events,
   `session/cancel` is `cancel`, `session/request_permission` is `onApproval`,
   `session/resume` is recovery. Two parts fit Leyline unusually well: `tool_call` content
   of type `diff` (`path`, `oldText`, `newText`) is a proposal, and `fs/read_text_file` /
   `fs/write_text_file` let the host hand the agent the **live draft** instead of the file
   on disk, which is the problem `./server/commands` exists to solve. It is JSON-RPC over
   stdio, so `codex-rpc.mjs` is most of the transport (it would need to send the
   `"jsonrpc": "2.0"` field, which `send()` at line 41 omits; inference from the
   specification's "follows JSON-RPC 2.0").
3. **Offer the host's operations as an MCP server.** `createCommandEndpoint` already holds
   a table of operations. ACP's `session/new` takes `mcpServers`, and Codex and the Claude
   Agent SDK both load MCP servers, so one MCP face replaces a per-host CLI and skill for
   every agent at once. Keep the loopback CLI for agents that only have a shell. Borrow
   MCP's `accept` / `decline` / `cancel` as the vocabulary for anything asked of a person.
4. **Shape the event log so it can be exported, then decide.** Once the store has an
   ordered log (below), writing it out as AG-UI events or as the AI SDK's UI message
   stream is a small mapper, and would let a host use assistant-ui or CopilotKit front
   ends, or let Leyline's panel sit in front of someone else's agent. Do not build this
   until a host asks; do name events so the mapping stays easy (start, delta, end per
   item; tool input and output; approval requested and answered).
5. **Not now: A2A.** It is for agents of different owners finding and calling each other
   across a network. No Leyline host has that problem.

## What Leyline should not try to be

- **Not a sync engine.** Yjs with Hocuspocus, Automerge, tldraw sync and Liveblocks exist
  and are hard-won. The README's "no shared-text or CRDT module" should stay true. Copycat's
  server-held draft (one draft, a revision, a log of splices) is enough for one person and
  some agents; if a host ever needs several people typing at once, adopt Yjs in that host.
- **Not a durable-execution engine.** Temporal, Inngest, Restate and DBOS each need a
  service or Postgres and impose replay rules on the code. A local, single-process tool
  needs three ideas from them, not the machinery: an append-only journal, an idempotency
  key on each request, and a recorded point from which a turn can be picked up.
- **Not an agent framework.** `http-chat` has no tool loop, and writing one means owning
  tool schemas, retries, context trimming and provider quirks that the AI SDK, Mastra,
  LangGraph and the vendor SDKs already own. Reach other models through agents that bring
  their own loop (ACP), and leave `http-chat` as the text-only adapter it says it is.
- **Not a general chat UI kit.** assistant-ui covers branching, attachments, voice and
  thread lists. Leyline's panel should stay the small one that knows about proposals,
  activity and routines.
- **Not a hosted service**, and not multi-tenant. Nothing in the store authenticates a
  caller or separates users; that is the host's, and the README is right to say so.

## Ranked changes

**Status on 2026-11-24 (0.7.0).** Items 1, 8, 9, 11 and 12 were built in 0.6.0. Items 2
to 7 and 10 were built in 0.7.0: asks (2), steering (3), the event log (4), subscribe
and Server-Sent Events (5), memory across a restart (6, without "continue" for the turn
that was interrupted), streaming (7, without opting out of unused notifications) and
the MCP face (10). The changelog says what each was checked against. The rest of this
document is as written against 0.5.0 and has not been revised.

Ordered by harm avoided first, then by what unblocks a host, then by reach. Sizes are
rough: small is under a day, medium a few days, large a week or more.

| # | Change | Why | Size | Module |
| --- | --- | --- | --- | --- |
| 1 | Never overwrite a conversation file that failed to parse: move it aside (`<name>.corrupt-<time>`), report through `onError`, then start empty | The only gap found that destroys a person's data without a word (robustness 1) | small | `server/conversations.mjs` `open()` |
| 2 | Answer agent requests by method, and let the answer be a promise: approvals (`accept`, `acceptForSession`, `decline`, `cancel`), `item/tool/requestUserInput`, `mcpServer/elicitation/request`; decline unknown methods with a JSON-RPC error; cancel pending ones when the turn stops | Wrong-shaped replies today; approvals shown to a person are one of Toucan's two blockers (robustness 3, 4) | medium | `server/providers/codex-app-server.mjs` `start()`, `server/codex-rpc.mjs` `reply`, `server/providers/contract.mjs` |
| 3 | Steering: `provider.steer(key, input)` over `turn/steer` with `expectedTurnId`, a `steer` capability, and `store.steer(key, turnId, text)` | Toucan's other blocker; lets the activity feed reach a running turn (robustness 5) | small to medium | `codex-app-server.mjs`, `contract.mjs`, `conversations.mjs`, README "Activity" |
| 4 | Replace whole-file rewrites with an append-only event log per conversation (one JSON line per event, each with a sequence number) plus an occasional snapshot; one write queue per conversation | Removes the cost that grows with history and the cross-conversation stall (performance 1, 2); is the base for items 5 and 6 | medium to large | `conversations.mjs` `persist`, `execute`, `open`; a reader for today's `{ key, turns }` files |
| 5 | `store.subscribe(key, { after })`: an async iterator of events from a sequence number, and a helper that writes it as SSE with `id:` so `Last-Event-ID` resumes | Hosts stop polling; a reload or dropped connection resumes exactly where it left off, the way MCP and Durable Streams define it (performance 3) | medium | `conversations.mjs`; new small `server/stream.mjs` |
| 6 | Keep the agent's memory across a restart: persist key to thread id, call `thread/resume` on first use, and offer "continue" for an interrupted turn instead of only "send it again" | Every comparable runtime does this; the id is already on disk in `provenance` (robustness 2) | medium | `codex-app-server.mjs` `run()`, `conversations.mjs` recovery and `messages.interrupted` |
| 7 | Stream the reply and command output: handle `item/agentMessage/delta` and `item/commandExecution/outputDelta`, set `textStream: true`, opt out of notifications that are not used | The person watches the answer arrive; the protocol already sends it (performance 4) | small | `codex-app-server.mjs` `event()`, `initialize` capabilities |
| 8 | Timeouts and kills: an idle timeout beside the total one; keep the thread on timeout; a store-level deadline that frees a lane; SIGKILL after a grace period and kill the process group | Hung runs wait 15 minutes, healthy long runs are cut, stray processes survive (robustness 6, 7, 8) | small to medium | `codex-app-server.mjs` line 135, `cli-oneshot.mjs` `runProcess`, `codex-rpc.mjs` `close`, `conversations.mjs` `execute` |
| 9 | An ACP client adapter (`AcpProvider`) on the existing stdio transport, mapping `session/update`, permissions, `diff` content to proposals, and optionally serving `fs/*` from the host's live draft | Most reach for one adapter: Claude, Gemini, Copilot, Cursor, OpenCode, Goose and others (interop 2) | large | new `server/providers/acp.mjs`; `codex-rpc.mjs` (JSON-RPC 2.0 field); `contract.mjs` |
| 10 | An MCP face for the command table: `createCommandEndpoint` operations listed and called as MCP tools over stdio, beside the loopback CLI | One integration for every MCP-capable agent, and what ACP's `mcpServers` expects (interop 3) | medium | `server/commands.mjs`; new `server/mcp.mjs` |
| 11 | Idempotency key on `send()` (`requestId`: the same id returns the existing turn); retry with backoff and `Retry-After` in `http-chat`; evict idle conversations and histories | Double-run on a browser retry, a busy model failing a turn outright, and slow memory growth (robustness 10, 11; performance 5) | small | `conversations.mjs` `send`, `http-chat.mjs` `run` and `failure`, the two `Map`s |
| 12 | Flush before rename (`fsync` the file and its folder) in both writers; a `validate(data)` option beside `json: true` so hosts check answers without a dependency; log dropped non-JSON lines through a hook | Cheap hygiene against the last ways data is lost or bad output trusted (robustness 9, 12, 13) | small | `conversations.mjs` `persist`, `server/files.mjs` `writePrivate`, `cli-oneshot.mjs`, `codex-rpc.mjs` |

Decisions in this list that belong to the owner, with the default taken here:

- **JSON lines, not SQLite, for item 4.** `node:sqlite` would give transactions and
  queries for free, but it is a release candidate only from Node 25.7 and Leyline states
  Node 22 as its minimum. Default: JSON lines now, in a shape SQLite could replace. Raising
  the minimum Node version would reverse this.
- **ACP before MCP (items 9 and 10).** Default: ACP first, because it adds agents, while
  MCP changes how existing ones reach the host. If Copycat's next need is a second agent's
  tools rather than a second agent, swap them.
- **No tool loop in `http-chat`.** Default: leave it text-only. Building one is the
  largest single way Leyline could drift into being an agent framework.

## What could not be verified

- Nothing was executed against Leyline or any other tool. Gaps were found by reading.
- The Codex documentation site redirected to another host and was not followed; Codex
  claims rest on the locally generated 0.171.0 types and the app-server README.
- LangGraph time travel and durability modes, Mastra agent tool approval, Liveblocks
  agents in comments and editors (HTTP 500), Hocuspocus persistence hooks, Temporal
  activity semantics, Trigger.dev waitpoints and stream resume: named by their docs, not
  read in detail. Each is marked in the table.
- The A2A specification was read only in its first part. MCP sampling was not read.
- Bundle sizes were not measured.
- ACP was read from its specification; no ACP agent was started, and the adapter list is
  the protocol site's own claim.
