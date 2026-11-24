# Benchmarks: before the hardening work

Recorded on commit ebd389b (0.5.0), before any change to `server/`.
Run with `npm run bench`. Each script runs in a process of its own, three times; the
table gives the best of the three, and the peak resident memory of that script's process
(scripts that print several rows share one figure).

Machine: `node -p process.version` v25.1.0, `nproc` 16, `uname -sr` Linux 7.2.5-3-omarchy.

What each row measures is described at the top of its script in this folder. Two rows
are not times: the size of the 200-turn conversation file, and how many of 1,000
automatic versions are left once history has thinned them.

| Benchmark | Result | Unit | Peak RSS |
|---|---:|---|---:|
| store: 1 activity update on a running turn | 3.511 | ms | 58 MB |
| store: 100 activity updates on a running turn | 4.498 | ms | 58 MB |
| store: 100 activity updates on a running turn | 22,234 | updates/s | 58 MB |
| store: 1,000 activity updates on a running turn | 10.65 | ms | 67 MB |
| store: 1,000 activity updates on a running turn | 93,908 | updates/s | 67 MB |
| store: 10,000 activity updates on a running turn | 47.17 | ms | 71 MB |
| store: 10,000 activity updates on a running turn | 211,977 | updates/s | 71 MB |
| store: open 1,000 conversations (10 turns each, 100 recovered) | 658 | ms | 508 MB |
| store: open 1,000 conversations (10 turns each, 100 recovered) | 0.6577 | ms/conversation | 508 MB |
| store: open 1,000 conversations at once | 356 | ms | 508 MB |
| store: 200-turn conversation, open | 9.208 | ms | 188 MB |
| store: 200-turn conversation, one activity update written | 9.909 | ms/update | 188 MB |
| store: 200-turn conversation, file size | 1,697 | KB | 188 MB |
| store: 150 requests sent at once, all finished and written | 713 | ms | 188 MB |
| rpc: 100,000 notifications through the line reader | 183 | ms | 67 MB |
| rpc: 100,000 notifications through the line reader | 545,326 | lines/s | 67 MB |
| sse: 100,000 events, 16 KB chunks | 156 | ms | 377 MB |
| sse: 100,000 events, 16 KB chunks | 641,733 | events/s | 377 MB |
| sse: 100,000 events, 64-byte chunks | 327 | ms | 377 MB |
| sse: 100,000 events, 64-byte chunks | 305,776 | events/s | 377 MB |
| sse: one 4 MB event in 1 KB chunks | 10,280 | ms | 377 MB |
| proposals: make 500 edits on a 1 MB document | 540 | ms | 134 MB |
| proposals: make 500 edits on a 1 MB document | 1.08 | ms/edit | 134 MB |
| proposals: undo all 500 edits | 565 | ms | 134 MB |
| proposals: refuse a one-letter find that occurs a million times | 13.72 | ms | 134 MB |
| proposals: refuse a 2,000-letter find that occurs a million times | 555 | ms | 134 MB |
| history: save 1,000 versions (all kept) | 3,055 | ms | 118 MB |
| history: save 1,000 versions (all kept) | 3.055 | ms/save | 118 MB |
| history: list 1,000 versions | 1.515 | ms | 118 MB |
| history: read one version of 1,000 | 1.268 | ms | 118 MB |
| history: restore a version (1,000 in the index) | 8.078 | ms | 118 MB |
| history: one pruning pass over 1,000 versions | 0.4263 | ms | 118 MB |
| history: save 1,000 automatic versions (thinned as they age) | 1,652 | ms | 118 MB |
| history: versions left after thinning | 204 | versions | 118 MB |
| activity: 100,000 events, 10 readers, 100,000 entries kept | 3,647 | ms | 139 MB |
| activity: 100,000 events, 10 readers, 100,000 entries kept | 27,423 | events/s | 139 MB |
| activity: 100,000 events, 10 readers, default keep (1,000) | 263 | ms | 139 MB |
| activity: 100,000 events, 10 readers, default keep (1,000) | 380,484 | events/s | 139 MB |

## What stands out

- **One large server-sent event read in small chunks is quadratic**: 4 MB arriving a
  kilobyte at a time takes seconds, because the whole buffer is copied and searched again
  for each chunk.
- **The activity feed slows with what it keeps**: with 100,000 entries kept, each reader's
  `pending()` scans all of them.
- **A burst of sends writes the whole conversation once per request**, one after another.
- **Each activity write of a 200-turn conversation rewrites about 1.7 MB.** The default
  `saveDelay` (600 ms) bounds how often that happens, not what it costs.
- **History** reads and rewrites its whole index on every call.
- **A long `find` that occurs everywhere** makes the uniqueness check compare the same
  text at every position.
