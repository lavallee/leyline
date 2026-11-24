# Benchmarks: 0.7.0, the event log

Run with `npm run bench`. Each script runs in a process of its own; the table gives the
best of five runs and the peak resident memory of that script's process (scripts that
print several rows share one figure).

Node v25.1.0, 16 CPUs (AMD Ryzen 7 5700G with Radeon Graphics), Linux 7.2.5-3-omarchy, 31 GB. Best of 5 runs; each script in its own process.

**Before** is the 0.6.0 code (tag `v0.6.0`, unpacked into a folder of its own) and
**After** is this branch at commit `0861b5b`, measured one after the other in the same
session on 2026-11-24, with the machine busy with other work throughout (load average
between 15 and 20 on 16 CPUs). The 0.6.0 run used this branch's `bench/store-large.mjs`,
so that the new `save(key)` row exists on both sides; the rows marked "new" measure calls
0.6.0 does not have. `before-0.7.0.json` and `results.json` hold the figures.

**How far to trust a row.** As before: repeating a script on this machine moves the same
figure by 20 to 30 per cent from one run to the next. A row marked 1.1× or 1.2× either
way is inside that and should be read as "no change measured". Nothing outside the
conversation store was changed in 0.7.0; its rows are here to show the spread.

| Benchmark | Before | After | Unit | Change | Peak RSS before | Peak RSS after |
|---|---:|---:|---|---:|---:|---:|
| store: 1 activity update on a running turn | 4.084 | 4.682 | ms | 1.1× slower | 58 MB | 61 MB |
| store: 100 activity updates on a running turn | 5.503 | 6.44 | ms | 1.2× slower | 59 MB | 61 MB |
| store: 100 activity updates on a running turn | 18,171 | 15,529 | updates/s | 1.2× slower | 59 MB | 61 MB |
| store: 1,000 activity updates on a running turn | 10.71 | 13.27 | ms | 1.2× slower | 67 MB | 69 MB |
| store: 1,000 activity updates on a running turn | 93,363 | 75,355 | updates/s | 1.2× slower | 67 MB | 69 MB |
| store: 10,000 activity updates on a running turn | 41.3 | 51 | ms | 1.2× slower | 71 MB | 76 MB |
| store: 10,000 activity updates on a running turn | 242,110 | 196,094 | updates/s | 1.2× slower | 71 MB | 76 MB |
| store: open 1,000 conversations (10 turns each, 100 recovered) | 454 | 563 | ms | 1.2× slower | 535 MB | 589 MB |
| store: open 1,000 conversations (10 turns each, 100 recovered) | 0.4535 | 0.5627 | ms/conversation | 1.2× slower | 535 MB | 589 MB |
| store: open 1,000 conversations at once | 285 | 469 | ms | 1.6× slower | 535 MB | 589 MB |
| store: 200-turn conversation, open | 5.724 | 10.16 | ms | 1.8× slower | 88 MB | 91 MB |
| store: 200-turn conversation, one activity update written | 10.75 | 0.1565 | ms/update | 69× faster | 88 MB | 91 MB |
| store: 200-turn conversation, file size | 1,697 | 1,687 | KB | 1,697 → 1,687 | 88 MB | 91 MB |
| store: 200-turn conversation, save(key) after changing one finished turn | 10.49 | 2.217 | ms/save | 4.7× faster | 88 MB | 91 MB |
| store: 200-turn conversation, update() of one finished turn |  | 0.109 | ms/update | new |  | 91 MB |
| store: 200-turn conversation, fold the log into a new snapshot |  | 12.68 | ms | new |  | 91 MB |
| store: 150 requests sent at once, all finished and written | 198 | 17.05 | ms | 12× faster | 88 MB | 91 MB |
| rpc: 100,000 notifications through the line reader | 194 | 156 | ms | 1.2× faster | 62 MB | 64 MB |
| rpc: 100,000 notifications through the line reader | 516,859 | 641,097 | lines/s | 1.2× faster | 62 MB | 64 MB |
| sse: 100,000 events, 16 KB chunks | 87.16 | 80.07 | ms | same (within 10%) | 195 MB | 198 MB |
| sse: 100,000 events, 16 KB chunks | 1,147,341 | 1,248,914 | events/s | same (within 10%) | 195 MB | 198 MB |
| sse: 100,000 events, 64-byte chunks | 249 | 220 | ms | 1.1× faster | 195 MB | 198 MB |
| sse: 100,000 events, 64-byte chunks | 401,317 | 455,470 | events/s | 1.1× faster | 195 MB | 198 MB |
| sse: one 4 MB event in 1 KB chunks | 7.62 | 7.266 | ms | same (within 10%) | 195 MB | 198 MB |
| proposals: make 500 edits on a 1 MB document | 494 | 445 | ms | 1.1× faster | 128 MB | 135 MB |
| proposals: make 500 edits on a 1 MB document | 0.9889 | 0.8895 | ms/edit | 1.1× faster | 128 MB | 135 MB |
| proposals: undo all 500 edits | 543 | 482 | ms | 1.1× faster | 128 MB | 135 MB |
| proposals: refuse a one-letter find that occurs a million times | 0.7628 | 0.6555 | ms | 1.2× faster | 128 MB | 135 MB |
| proposals: refuse a 2,000-letter find that occurs a million times | 0.3215 | 0.3032 | ms | same (within 10%) | 128 MB | 135 MB |
| history: save 1,000 versions (all kept) | 1,972 | 1,857 | ms | same (within 10%) | 99 MB | 99 MB |
| history: save 1,000 versions (all kept) | 1.972 | 1.857 | ms/save | same (within 10%) | 99 MB | 99 MB |
| history: list 1,000 versions | 0.2401 | 0.2281 | ms | same (within 10%) | 99 MB | 99 MB |
| history: read one version of 1,000 | 0.09379 | 0.09021 | ms | same (within 10%) | 99 MB | 99 MB |
| history: restore a version (1,000 in the index) | 4.094 | 3.884 | ms | same (within 10%) | 99 MB | 99 MB |
| history: one pruning pass over 1,000 versions | 0.3258 | 0.3147 | ms | same (within 10%) | 99 MB | 99 MB |
| history: save 1,000 automatic versions (thinned as they age) | 1,296 | 1,251 | ms | same (within 10%) | 99 MB | 99 MB |
| history: versions left after thinning | 204 | 204 | versions | same | 99 MB | 99 MB |
| activity: 100,000 events, 10 readers, 100,000 entries kept | 102 | 98.43 | ms | same (within 10%) | 141 MB | 140 MB |
| activity: 100,000 events, 10 readers, 100,000 entries kept | 981,978 | 1,015,958 | events/s | same (within 10%) | 141 MB | 140 MB |
| activity: 100,000 events, 10 readers, default keep (1,000) | 88.73 | 87.11 | ms | same (within 10%) | 141 MB | 140 MB |
| activity: 100,000 events, 10 readers, default keep (1,000) | 1,127,072 | 1,148,011 | events/s | same (within 10%) | 141 MB | 140 MB |

## What changed, and what did not

Faster, and why:

- **One activity update written to a 200-turn conversation: about 70×** (10.8 ms to
  0.16 ms). This is the cost the 0.6.0 audit measured and could not remove. An update is
  now a line appended to the conversation's log, about a hundred bytes, instead of 1.7 MB
  serialised and written whole. The cost no longer grows with the conversation.
- **A burst of 150 sends: about 12×** (198 ms to 17 ms). Each send appends a line; before,
  the writes that could not be merged each rewrote everything sent so far.
- **`save(key)` after a host changed one finished turn: about 5×** (10.5 ms to 2.2 ms).
  It still looks at every turn, to find what changed, but writes only that. This is what
  Copycat does today when the fate of a proposal changes.
- **`update()` of one finished turn: 0.11 ms** (new). It compares one turn instead of
  all of them: about 20× cheaper than `save(key)`, and about 100× cheaper than the same
  change cost in 0.6.0.

Slower, measured:

- **Opening a conversation: 1.2× to 1.8×.** A 200-turn conversation takes about 10 ms to
  open against about 6 ms; a thousand ten-turn conversations take about 0.56 ms each
  against 0.45 ms, and 469 ms against 285 ms when all are opened at once. Opening now
  also reads the log (a second file, usually absent or short) and records, for every
  turn, what it will later compare changes against: the JSON of each small field and of
  each activity item without its text. Text is kept by reference and costs nothing.
  A profile of the thousand-conversation run puts roughly a third of the open time
  there. Reading the two files together instead of one after the other was tried and
  made no measurable difference. This is a cost paid once per conversation per process,
  in exchange for the per-update cost above; a host that opens far more conversations
  than it updates would feel it.
- **Activity updates on a short conversation: 1.1× to 1.2× slower in this run** (10,000
  updates in 51 ms against 41 ms). That is inside the run-to-run spread, but there is a
  real reason for some of it: each update is now also recorded as it arrives (which item
  changed, and by what text), where before nothing was done until the write. A first
  version compared the whole text on every update with `startsWith` and took 315 ms for
  the same row; it now uses what the fold already knows was added.
- **Peak memory: 3 to 10 per cent more** in the store rows (589 MB against 535 MB for a
  thousand open conversations), for the record of each turn kept to compare against.

New, with no counterpart before:

- **Folding a 200-turn conversation's log into a new snapshot: about 13 ms.** This is
  the old whole-file write, now paid once per `compactEvery` events (1,000 by default)
  and on `close()` instead of on every update.

Not measured here: delivering events to subscribers and over Server-Sent Events (the
stream tests exercise it, including a 12 MB flood to a client that stops reading, but
nothing times it); `fsync: true`, which now also flushes after each append; and anything
with a real agent.

---

# Earlier: after the hardening work (0.6.0)

Run with `npm run bench`. Each script runs in a process of its own; the table gives the
best of five runs and the peak resident memory of that script's process (scripts that
print several rows share one figure).

Machine: `node -p process.version` v25.1.0, `nproc` 16, `uname -sr` Linux 7.2.5-3-omarchy.

**Before** is the 0.5.0 code (commit 56c53ea, the one `BASELINE.md` was recorded on)
measured again in the same session, immediately before **After** (commit 46abb11 plus
the documentation commit this file is in). It was measured again, not copied from
`BASELINE.md`, because the machine was busy with other work during this run (load
average between 20 and 30 on 16 CPUs) and was not when the baseline was taken; the two
columns here were at least taken under the same conditions. `baseline.json` and
`results-0.6.0.json` hold the figures.

**How far to trust a row.** Repeating single scripts back and forth between the two
versions on this machine moved the same figure by 20 to 30 per cent from one run to the
next. A row marked 1.1× or 1.2× either way is inside that and should be read as "no
change measured". The rows that are real are the ones that moved by a factor of two or more.

| Benchmark | Before | After | Unit | Change | Peak RSS before | Peak RSS after |
|---|---:|---:|---|---:|---:|---:|
| store: 1 activity update on a running turn | 3.115 | 3.596 | ms | 1.2× slower | 58 MB | 58 MB |
| store: 100 activity updates on a running turn | 4.168 | 5.143 | ms | 1.2× slower | 58 MB | 59 MB |
| store: 100 activity updates on a running turn | 23,992 | 19,446 | updates/s | 1.2× slower | 58 MB | 59 MB |
| store: 1,000 activity updates on a running turn | 11.13 | 10.31 | ms | same (within 10%) | 66 MB | 66 MB |
| store: 1,000 activity updates on a running turn | 89,879 | 97,029 | updates/s | same (within 10%) | 66 MB | 66 MB |
| store: 10,000 activity updates on a running turn | 42.14 | 38.07 | ms | 1.1× faster | 72 MB | 72 MB |
| store: 10,000 activity updates on a running turn | 237,299 | 262,684 | updates/s | 1.1× faster | 72 MB | 72 MB |
| store: open 1,000 conversations (10 turns each, 100 recovered) | 422 | 406 | ms | same (within 10%) | 535 MB | 535 MB |
| store: open 1,000 conversations (10 turns each, 100 recovered) | 0.4216 | 0.4059 | ms/conversation | same (within 10%) | 535 MB | 535 MB |
| store: open 1,000 conversations at once | 276 | 261 | ms | same (within 10%) | 535 MB | 535 MB |
| store: 200-turn conversation, open | 6.115 | 5.229 | ms | 1.2× faster | 187 MB | 86 MB |
| store: 200-turn conversation, one activity update written | 9.533 | 9.416 | ms/update | same (within 10%) | 187 MB | 86 MB |
| store: 200-turn conversation, file size | 1,697 | 1,697 | KB | same | 187 MB | 86 MB |
| store: 150 requests sent at once, all finished and written | 593 | 170 | ms | 3.5× faster | 187 MB | 86 MB |
| rpc: 100,000 notifications through the line reader | 147 | 176 | ms | 1.2× slower | 66 MB | 62 MB |
| rpc: 100,000 notifications through the line reader | 679,551 | 567,673 | lines/s | 1.2× slower | 66 MB | 62 MB |
| sse: 100,000 events, 16 KB chunks | 109 | 92.12 | ms | 1.2× faster | 380 MB | 200 MB |
| sse: 100,000 events, 16 KB chunks | 921,705 | 1,085,577 | events/s | 1.2× faster | 380 MB | 200 MB |
| sse: 100,000 events, 64-byte chunks | 272 | 276 | ms | same (within 10%) | 380 MB | 200 MB |
| sse: 100,000 events, 64-byte chunks | 367,335 | 362,421 | events/s | same (within 10%) | 380 MB | 200 MB |
| sse: one 4 MB event in 1 KB chunks | 9,629 | 7.784 | ms | 1237× faster | 380 MB | 200 MB |
| proposals: make 500 edits on a 1 MB document | 460 | 504 | ms | same (within 10%) | 130 MB | 130 MB |
| proposals: make 500 edits on a 1 MB document | 0.9209 | 1.008 | ms/edit | same (within 10%) | 130 MB | 130 MB |
| proposals: undo all 500 edits | 522 | 551 | ms | same (within 10%) | 130 MB | 130 MB |
| proposals: refuse a one-letter find that occurs a million times | 13.2 | 0.7035 | ms | 19× faster | 130 MB | 130 MB |
| proposals: refuse a 2,000-letter find that occurs a million times | 504 | 0.3326 | ms | 1514× faster | 130 MB | 130 MB |
| history: save 1,000 versions (all kept) | 2,713 | 2,396 | ms | 1.1× faster | 118 MB | 101 MB |
| history: save 1,000 versions (all kept) | 2.713 | 2.396 | ms/save | 1.1× faster | 118 MB | 101 MB |
| history: list 1,000 versions | 1.191 | 0.3311 | ms | 3.6× faster | 118 MB | 101 MB |
| history: read one version of 1,000 | 1.016 | 0.1055 | ms | 9.6× faster | 118 MB | 101 MB |
| history: restore a version (1,000 in the index) | 5.882 | 4.706 | ms | 1.2× faster | 118 MB | 101 MB |
| history: one pruning pass over 1,000 versions | 0.3364 | 0.3603 | ms | same (within 10%) | 118 MB | 101 MB |
| history: save 1,000 automatic versions (thinned as they age) | 1,466 | 1,575 | ms | same (within 10%) | 118 MB | 101 MB |
| history: versions left after thinning | 204 | 204 | versions | same | 118 MB | 101 MB |
| activity: 100,000 events, 10 readers, 100,000 entries kept | 3,339 | 120 | ms | 28× faster | 154 MB | 157 MB |
| activity: 100,000 events, 10 readers, 100,000 entries kept | 29,947 | 831,707 | events/s | 28× faster | 154 MB | 157 MB |
| activity: 100,000 events, 10 readers, default keep (1,000) | 211 | 100 | ms | 2.1× faster | 154 MB | 157 MB |
| activity: 100,000 events, 10 readers, default keep (1,000) | 474,006 | 998,982 | events/s | 2.1× faster | 154 MB | 157 MB |

## What changed, and what did not

Faster, and why:

- **One 4 MB server-sent event in 1 KB chunks: about 1,200×.** The parser no longer
  copies and re-scans everything it holds for each chunk. Its peak memory halved.
- **Activity feed with 100,000 events kept: about 28×.** A reader's place is found by
  binary search, and dropping old events moves a mark instead of shifting the list. The
  default (1,000 kept) is about 2× faster for the same reason.
- **A burst of 150 sends to one conversation: about 3.5×,** with less than half the
  memory. Writes that pile up behind one in progress are merged; before, each send
  rewrote the whole conversation in turn.
- **History list and read with 1,000 versions: about 4× and 10×.** The index is kept in
  memory while the file on disk is unchanged.
- **Refusing a find that occurs everywhere: 19× and about 1,500×.** The check stops at
  the second occurrence. The case that matters more is not in the table because it was
  too slow to put in a benchmark: one 100,000-character find against 1 MB of repeating
  text took 25 seconds in a single `indexOf`; it now takes milliseconds
  (`test/proposals.test.mjs`).

Not faster, measured:

- **One write of a 200-turn conversation: unchanged, about 10 ms for 1.7 MB.** The
  conversation is still serialised and written whole. Batching (`saveDelay`) and merging
  bound how often that happens, not what it costs. Caching the text of finished turns
  was considered and not done: Copycat changes finished turns (the fate of a proposal)
  without telling the store, and relies on the next write carrying it. Removing the cost
  properly needs an append-only log, which was left for a later pass.
- **Saving a history version: unchanged, 2 to 3 ms.** Compression and two file writes;
  the index is still rewritten whole on each save.
- **`proposals.make` on a 1 MB document: unchanged, about 1 ms an edit.** The time is in
  scanning the megabyte for a second occurrence and building the new string. Reusing the
  position found by the check was tried, measured no different, and was reverted.
- **JSON-RPC framing: unchanged** at 550,000 to 680,000 lines a second through a real
  pipe. The package's own line reader replaced `readline` for the sake of a length cap,
  not speed; most of the time is `JSON.parse` and the pipe.
- **Opening 1,000 conversations: unchanged.**

Slower:

- **The first write a store makes: about half a millisecond more.** The store now lists
  its folder once to clear temporary files a dead process left behind. It shows in the
  rows for 1 and 100 activity updates, which finish in a few milliseconds in all, and
  nowhere else. Writing through a file handle instead of `fs.writeFile` was also slower
  (about 1.5× per write) and was changed back, except when `fsync` is asked for.

Not measured: `fsync: true` end to end. One write of the same 1.7 MB file with a flush
took about 17 ms against 9 ms without, in a one-off measurement on this machine's btrfs.
