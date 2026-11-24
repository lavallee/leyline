# Benchmarks: after the hardening work

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
`results.json` hold the figures.

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
