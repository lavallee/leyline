# Changelog

## Unreleased

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
