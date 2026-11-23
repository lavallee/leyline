# Changelog

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
