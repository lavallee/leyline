# Patterns: what the three hosts do, and what is in this package

Written 2026-11-23 for 0.4.0. An inventory of the ways Toucan (a canvas), Copycat (an
in-place document editor) and Skein (a thread editor) let people and agents work on the
same thing, read from their code. For each pattern: what it does for the person, where
it lives in each host, whether its core is independent of the host's document, and what
this package now holds.

Sources read: Toucan `main` (`server/*.mjs`, `lib/*.mjs`, `docs/agents/*.md`), Copycat
branch `agent-chat` (`src/chat.js`, `src/live.js`, `src/agent.js`, `src/review.js`,
`extension/editor.js`, `bin/copycat-doc.mjs`), Skein (`src/chat.js`,
`src/agent-provider.js`). Paths below are relative to each host's repository. Toucan's
`server/plan.mjs`, `lib/plan.mjs`, `lib/reflexes.mjs`, `server/references.mjs`,
`server/sources.mjs` and `lib/agents.mjs` were read in outline (their headers, exports
and the parts cited), not line by line.

"Extracted" means a module here was written from the hosts' code and is tested alone.
**No host has been moved onto any of these modules yet**, so each still has to meet
its first real use.

## Summary

| Pattern | For the person | In this package | Why |
| --- | --- | --- | --- |
| Chat panel | Talk to the agent beside the document | `.` `./ui/*` `./dock` `./activity` `./routine-menu` (0.2.3) | Already shared by Copycat and Skein |
| Agent providers | The same panel can sit in front of different agents | `./server/providers` (0.3.0) | Written three times |
| Conversations, queue, lanes | Send another request while one runs; nothing is lost on restart | `./server/conversations` (0.3.0) | Copycat and Skein near copies |
| Agent commands | The agent reaches the live document, not a stale file | `./server/commands` (0.3.0) | Same pattern in Copycat and Toucan |
| Telemetry | The owner can see what agents cost | `./server/telemetry` (0.3.0) | New; optional |
| Routines | A chore written once, run again with one click | `./server/routines` (bank), `./server/routine-set` (0.4.0) | Same logic in all three |
| History | Step back to any earlier state; undo a whole request | `./server/history` (0.4.0) | Core takes the document as opaque data |
| Proposals | See, accept, undo what the agent changed | `./server/proposals` (0.4.0) | Ledger and fates are generic; the edit kind is open |
| Activity | The agent notices what people did while it worked | `./server/activity` (0.4.0) | Feed, cursors and attribution are generic; the differ is the host's |
| Threads | Comment on a place; an agent answers there | `./server/threads` (0.4.0) | Anchors opaque; the rest is generic |
| Profiles | Work with a named agent that knows its own material | `./server/profiles` (0.4.0) | Nothing canvas-specific in it |
| Work log and trail | Routines learned from real work; "while you were away" | `./server/worklog` (0.4.0) | Generic once the routine-coverage table is the host's |
| Reflexes | The document tends itself without calling a model | Host-side | Conditions are code run against the canvas in a browser tab |
| Brief | The agent acts without reading the document first | Host-side | It is a rendering of the host's document |
| Presence | People see where the agent is working | Host-side | Drawn in the host's editor |
| Draft sync | The agent reads what the person sees | Host-side for now | Needs the shared-text module that is not built |
| Review log | Screenshots of work, with pinned notes and replies | Not extracted (candidate) | Independent of the canvas, but outside this pass |
| Plans and sources | A board or timeline of a project, edited on the canvas | Host-side | A product feature of the canvas, not an agent pattern |
| References | Read a project's files and web pages beside the canvas | Host-side | A file and web reader with its own safety rules |
| Agent installation | Teach the agents on this machine to use the tool | Not extracted (candidate) | Independent, but each host's skill and CLI differ |

## Routines

**For the person.** A chore is written once ("proofread", "tidy arrows") and then run from
a menu, a slash command in the chat, or a CLI. Hosts ship some; people and agents bank
their own; a banked routine with a shipped routine's name replaces it.

| | Where |
| --- | --- |
| Toucan | `server/routines.mjs`: routines are JavaScript run on the canvas, stored as `.js` files with a comment header (`routine`, `description`, `engines`, `kind`, `when`, `args`); seven kinds group the menu; `when` tells an agent when to reach for one and `args` what it takes (the CLI's `--when` and `--takes`). `server/brief.mjs` `parseDirect` reads `/name`. Its own bank, not the package's. |
| Copycat | `src/chat.js`: four shipped prompt routines, `createRoutineBank` for banked ones as JSON, slash resolution in `send()`, `saveRoutine`, `removeRoutine` (moves the file to `archive/`), the routine's title shown as the request and its prompt sent. |
| Skein | `src/chat.js`: the same as Copycat with four of its own shipped routines and engine `thread`. |

**Host-independent?** Yes, except running one. What a routine's `code` is (a prompt, or a
program for a canvas) and how it is run stay with the host. Toucan's `program()`, which
wraps a routine's code for its canvas, stays in Toucan.

**Extracted:** `./server/routine-set`. Shipped (objects or a folder) merged with banked,
engines, kinds, `when` and `args`, slash resolution, `turnFor` (a message as a request),
validated save, remove with an archive, and two file formats: JSON (Copycat, Skein) and
the comment header (Toucan). Differences a host will meet: Toucan deletes a removed
routine, this archives it; Toucan's header parser stops at the first line of code, as
this one does, and both keep the code's own header fields that are not passed.

## History

**For the person.** Every state the document has been in can be stepped back to and
restored, and "undo everything from this request" is one action.

| | Where |
| --- | --- |
| Toucan | `server/versions.mjs`: whole gzipped snapshots per canvas with an index, no-op saves skipped by hashing a `shapes` map, a summary of what each version changed, pruning by age and size, restore that saves the present first. "One exec is one undo step" is the browser editor's own undo, in the tab that ran it. |
| Copycat | No version store. The browser keeps undo points (`liveUndoPoint` in `extension/editor.js`), and `undoTurn` reverses a request's edits one by one (see Proposals). Saved files are the source repository's business. |
| Skein | None; the draft is in the browser. |

**Host-independent?** Yes. The store never looks inside the document.

**Extracted:** `./server/history`. Toucan's store with the document as opaque `data`
(text or JSON) and `shapes` generalised to `parts`; plus checkpoints per request, which
Toucan does not have: `checkpoint(key, requestId, state)` when a request begins and
`undoRequest(key, requestId)` to restore it. That restore puts the whole document back,
including undoing what people did during the request. The finer route, reversing only
the request's own edits, is `proposals.undoRequest`. A host chooses; Copycat's behaviour
today is the finer one.

Not carried over: Toucan's `TOUCAN_VERSION_MAX_MB` environment variable (the cap is the
`maxBytes` option).

## Proposals

**For the person.** What the agent changed is visible as separate items that can be
looked at, accepted or taken back, one at a time or a whole request at once, and nothing
is saved until they say so.

| | Where |
| --- | --- |
| Copycat | `src/chat.js`: `turn.proposals` with `auto` (made at once through the agent's `edit` command) and `fate` (`applied`, `stale`, `undone`, reported by the browser in `sync`), `missed()` which tells the agent once about edits that did not stay. `extension/editor.js`: `applyProposal`, `applyAgentEdits` (apply by default), `undoProposal` (the reverse replace, refused unless unambiguous), `undoTurn`, `proposalState`, `markChanges` (marks blocks changed, and by the agent). |
| Skein | `src/chat.js` `proposals()`: the agent returns structured changes to posts (`replace`, `insertBefore`, `insertAfter`, `remove`), checked against the draft; the browser applies the ones the author accepts. Held, never automatic. |
| Toucan | Shapes drawn dashed carrying `meta.proposed`; an Accept and Reject bar (`app/ProposalBar.tsx`); `toucan proposals accept|reject`. The proposal is the shape itself, in the document. |

**Host-independent?** Partly. The ledger is: recording a proposal on its turn, offered or
made, its fate kept apart from what the agent believes, telling the agent once, undoing
one or a request in reverse order. What an edit is, how it is checked against the
document, applied and reversed is not: it is text in Copycat, posts in Skein, shapes in
Toucan.

**Extracted:** `./server/proposals`, with the kind left open. Find-and-replace on named
text files is built in (`textEdit`, Copycat's rule: the text to replace must occur exactly
once). A host passes other kinds as objects with `validate`, `check`, `apply`, `invert`
and `label`.

**Stays in hosts:**
- Applying an edit to what the person sees: the caret, the highlight, `markChanges`.
  That is the editor.
- Skein's post operations and their length counting, as a kind Skein would write.
- Toucan's dashed proposals. They live in the canvas document and are accepted by
  redrawing a shape; the ledger here would only shadow them. A Toucan kind is possible
  but nothing suggests it is wanted.
- Copycat's rule that only requests made since this browser began applying edits are
  applied automatically (`autoFrom`).

## Activity ("what people did meanwhile")

**For the person.** They keep working while the agent works, and the agent builds on what
they did instead of undoing it.

| | Where |
| --- | --- |
| Toucan | `server/activity.mjs`: a feed per canvas of shapes added, changed and removed, comments and selections; attribution by claims (a run reports what it touched; an unclaimed change is a person's); a place per reader with `pending` and `ack`; `describe` and `format` produce the `<canvas_activity>` block. Delivered by `notice()` in `server/codex.mjs` as a steer of the turn in progress, and to terminal agents with their next command. |
| Copycat | Only the list of undone edits (`undone` in `sendLive`, `missed()`); the whole draft is sent with each message instead. |
| Skein | None; the whole draft is sent each turn. |

**Host-independent?** The feed, the readers' places, claims, selections, merging several
changes into one and the block format are. Reading a document into comparable rows
(`tldrawRows`, `excalidrawRows`), deciding what differs (`rowChanges`, the rule that a
box carried by its frame did not move) and wording a change are the canvas's.

**Extracted:** `./server/activity`. The host passes `snapshot(doc)` and `diff(before,
after)`, or reports changes itself with `changed()`, and words each change in
`describeEvents`. Toucan's actor kind `canvas` (reflexes and plan sync, never told to
readers) is `system` here.

**Stays in hosts:** the row readers and differ; delivery (Toucan steers a running turn;
this package's Codex adapter has no steering yet, so a host can tell an agent at its
next command or next turn, not mid-turn).

## Threads (comments handed to agents)

**For the person.** A comment sits on a place in the document. People and agents answer
in it and close it; a comment can be handed to an agent, which does what it asks and
replies there.

| | Where |
| --- | --- |
| Toucan | `server/threads.mjs`: threads beside the canvas with anchors on shapes or a region, messages by person or agent, `seen` (what the thread's own agent has been told), close and reopen, `promptFor`. `askThread` in `server/codex.mjs` gives each thread its own conversation (`canvas#id`); `agentAnswered` posts the reply. Sticky notes are adopted as threads. |
| Copycat | `src/review.js`: comments stored as JSON in the source repository, anchored by character offsets at a file revision and re-found by quoted text (`placeComment`); replies, resolve, reopen, edit, history. `src/chat.js`: `sendLive` with `request.comment`, `where()` to say where it sits, and the agent's `reply` command, which posts on the comment. |
| Skein | None. |

**Host-independent?** Yes, with the anchor opaque. Finding an anchor again after the
document changes, and describing it, need the document.

**Extracted:** `./server/threads`: Toucan's store, plus `handOff`, which is the pattern
both hosts built: give the agent what it has not seen, and post its final message as the
reply (or accept that it replied through a command).

**Stays in hosts:** anchors (`cleanAnchor`, `describeAnchor`, `anchorLine` in Toucan;
`anchor()` and `placeComment` in Copycat), sticky-note adoption, and Copycat's choice to
keep comments in the source repository in a format people read. A host with storage of
its own passes `storage`; Copycat adopting this module would change its comments file
format (`resolved` becomes `closed`, a comment becomes a thread with messages), which is
a decision for the owner, not a refactor.

## Profiles

**For the person.** The chat beside a document can be with a named agent that has its own
folder, briefing and skills, instead of a general-purpose one.

| | Where |
| --- | --- |
| Toucan | `server/profiles.mjs`: profiles from local JSON files and from `toucan-profiles-NAME` programs on `PATH`; `checkProfile` (the folder must be the agent's own, context and references inside it and not hidden, no writing granted); `profileInstructions`; a canvas is bound to a profile, and its conversations are keyed by the binding. |
| Copycat, Skein | None. |

**Host-independent?** Yes.

**Extracted:** `./server/profiles`: sources (files, any object with `list` and `get`, or
a program), `checkProfile`, `profileInstructions`, bindings, and the tie to providers:
`requestFor(profile, request)`, `providerFor`, `conversationKey`. A profile may name a
`provider`, which Toucan's do not. Finding plugin programs on `PATH` (Toucan's
`server/plugins.mjs`) stays in Toucan; a host passes the commands it trusts.

## Work log and trail

**For the person.** The tool notices chores agents keep doing by hand and offers to bank
them as routines; it can say which routines are used; and it shows what agents changed
while nobody was looking.

| | Where |
| --- | --- |
| Toucan | `server/worklog.mjs`: a log of runs, `suggest` (repeated hand-written code grouped by shape), `stats`. `server/trail.mjs`: per-canvas log of changes made with no tab open. |
| Copycat, Skein | None. Copycat writes each one-shot request and answer to its state directory (`src/agent.js`), which is a record, not a log to learn from. |

**Host-independent?** The logs, the statistics and the grouping are. Toucan's table of
which helper calls an existing routine already covers (`COVERED`, `DOES`, `touches`) is
about its canvas API.

**Extracted:** `./server/worklog` (`createWorkLog`, `routineStats`, `suggestRoutines`,
`shapeOf`, `createTrail`). The host passes `covers(code, shape)` for its own knowledge.
`suggestRoutines` groups code; for hosts whose agents work through prompts and edits
rather than code (Copycat, Skein) it has nothing to group, and only the statistics and
the trail apply.

## Host-side, and why

**Reflexes** (Toucan `server/reflexes.mjs`, `lib/reflexes.mjs`). A tree of situations and
answers judged whenever the canvas goes quiet, so common fixes happen without a model.
The decision rules in `lib/reflexes.mjs` (`observe`, `decide`, `mark`, `settled`,
`braked`) take plain data and could be lifted. But a node's `when` and `do` are function
bodies evaluated in a browser tab against the canvas, the judging is scheduled around
people dragging and typing in that editor, and "people win" is detected through the
editor's undo. Extracting the rules alone would leave a module no other host can drive.
Left in Toucan; worth revisiting if a second host wants standing behaviour.

**Brief** (Toucan `server/brief.mjs`). The canvas as compact lines sent with each message,
so the agent's first move can be the edit. Copycat's equivalent is the `<document_draft>`
block in `runLive`. Both are a rendering of the host's own document. `parseDirect`'s
slash-name half is in `./server/routine-set`.

**Presence** (Toucan `app/pulses.tsx`, `toucan say`). A pill, a cursor and a glow showing
where the agent is working. Copycat's `flash()` is the same idea. Drawn in the host's
editor.

**Draft sync** (Copycat `sync()` in `src/chat.js`, `syncDraft` in `extension/editor.js`).
The browser posts its text and what became of each edit. The fates half is in
`./server/proposals` (`report`, `replay`). The text half is the two-copies problem the
design study (`copycat/docs/collaboration-library.md`, section 4) proposes to solve with
one server-held draft; that shared-text module is not built.

**Review log** (Toucan `server/review.mjs`). Revisions of an artifact as screenshots, notes
pinned on them, replies from the producer, idempotent mutations with receipts. It does
not depend on the canvas and could be a module. Not extracted in this pass: it was not
in the requested list and no second host uses it.

**Plans and sources** (Toucan `server/plan.mjs`, `lib/plan.mjs`, `server/sources.mjs`).
Views of a project-management source drawn on a canvas and read back from it. The source
protocol is independent of the canvas; the rest is canvas rendering. A product feature,
not a way of working with an agent.

**References** (Toucan `server/references.mjs`). Reading a canvas's files, its linked
project and web pages beside the canvas, with path and network rules. Host-side.

**Agent installation** (Toucan `lib/agents.mjs`). Installs a skill and an MCP entry into
the coding agents found on the machine. Independent of the canvas, and every host that
ships a CLI for agents will want it; not extracted because each host's skill, CLI and
MCP server differ and only Toucan has one today.

## What could not be checked

- Nothing here was run inside a host. Each module is tested alone and in
  `test/together.test.mjs`, which wires them as a small host would.
- Toucan's files listed above as "read in outline" may hold details this table misses.
- Toucan's browser side (`app/`) was not read, beyond the file names cited from the
  design study.
