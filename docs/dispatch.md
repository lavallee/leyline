# Dispatch: handing work to a runner, and hearing back

Written 2026-11-24. A person reading a document spots something that needs doing
somewhere else (fix the renderer, redraw a diagram, chase a figure) and sends it from the
page. A tool built on this package does not do that work itself. It hands the work to a
**runner** through a small contract, keeps a record of what it sent, asks the runner what
became of it, and shows the answer on the page.

The contract is public and small on purpose: anyone can write a runner for their own
setup. One runner ships here (`command`, below). Others live with the systems they drive
(Fab's runner in Fab, a task-ledger runner in Daymark) and nothing here imports them.

## The runner contract (version 1)

A runner is a command. The host runs it once per operation with the operation as its last
argument, writes one JSON object to its stdin, and reads one JSON object from its stdout.
A non-zero exit, or output that is not one JSON object, is a failure, reported in the
runner's own last line of output.

| Operation | stdin | stdout |
| --- | --- | --- |
| `submit` | `{ v: 1, key, title, brief, from, where, by }` | `{ id, status, link?, summary? }` |
| `status` | `{ v: 1, id }` | `{ id, status, link?, summary?, result? }` |
| `cancel` | `{ v: 1, id }` | `{ id, status }` |

- `key`: the host's id for the item. A runner that is given the same `key` twice returns
  the job it already has, so a retried `submit` is safe.
- `title`: a line for lists. `brief`: everything the work needs, in prose.
- `from`: where on the document this came from: `{ document, url?, file?, quote?, start?,
  end? }`. Locations come from the host's parser, never from the browser.
- `where`: where the work may happen, from the host's configuration: `{ root?, paths? }`.
  The runner is told; keeping to it is the runner's job.
- `by`: who sent it, `person` or `agent`.
- `status`: one of `queued`, `running`, `needs-review`, `done`, `failed`, `cancelled`.
  `needs-review` means a person must look, at `link` or in `summary`.
- `result` (when finished): `{ message?, links?: [{ label, url }], files?: [{ path, change }] }`.
  The host shows it and never acts on it by itself.
- A runner that does not support an operation exits non-zero saying so. The host reports
  that in its own words.
- Every string is plain text. Lengths the host keeps: title 200, brief 20,000, summary
  2,000, message 20,000, 20 links, 200 files.

## On the host: `./server/dispatch`

```js
import { createDispatch } from '@lyra-forge/leyline/server/dispatch';

const work = createDispatch({
  dir,                       // where items are kept, one JSON file per document
  destinations: {            // from the host's configuration, never from a request
    fab: { label: 'Fab', runner: ['/path/to/fab-runner'], where: { root: '/repo' }, approval: 'owner', timeout: 30 },
  },
});
```

- `work.create(document, { destination, title, brief, from, by })` records an item. With
  `approval: 'owner'` (or when `by` is `agent`, unless the destination says
  `agentApproval: 'none'`) it is `held` until `work.send`; otherwise it is sent at once.
- `work.send(document, itemId)` submits a held item. `work.cancel(document, itemId)` asks the
  runner to cancel (or drops a held item). `work.refresh(document, itemId?)` asks the runner
  for the status of open items. `work.list(document)` returns the items, newest first.
- An item is `{ id, key, destination, title, brief, from, by, createdAt, status, job?,
  link?, summary?, result?, error?, updatedAt }`. `status` adds `held` and `sending` to the
  runner's statuses. A runner failure leaves the item where it was, with `error` saying
  what the runner said; nothing is lost.
- Writes are atomic and private (`files.mjs`), one document at a time.

## On the page: `./work-panel`

`WorkPanel` is the strip's panel for these items (`docs/shell.md`): each item's title,
destination, status, summary and links, with **Send** for a held item, **Cancel** for an
open one, and **Refresh**. `SendWork` is the small form a host opens from a selection or a
comment: what should happen, and which destination. The host supplies the calls, as for
History.

## The `command` runner

`leyline-runner-command` (`bin/runner-command.mjs`) runs one configured agent command for each job, with
the brief on stdin and `where.root` as its working folder, and keeps each job in its own
folder under a state directory: what it was given, its output, its exit. `status` reads
that folder: `running` while the command runs, `done` with its last message on exit 0,
`failed` with the last lines of its output otherwise. It is the reference implementation
of the contract and enough for anyone with a coding agent's CLI:

```sh
DISPATCH_RUNNER_STATE=~/.local/state/dispatch-runner \
DISPATCH_RUNNER_COMMAND='["codex","exec","--full-auto","-"]' \
  leyline-runner-command submit < brief.json
```

The command and state folder come from the environment the host starts it with, so they
are the host's configuration, not the request's.
