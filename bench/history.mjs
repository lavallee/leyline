// History with 1,000 versions of a 50-part, 20 KB document: saving them (an hour apart on
// the history's own clock, so thinning by age runs as it would over six weeks), listing,
// reading, restoring, and one pruning pass over the index.
import { createHistory, prunable } from '../server/history.mjs';
import { bench, ms, round, prose } from './lib.mjs';

await bench(async ({ dir, row }) => {
  const versions = 1000, HOUR = 36e5;
  let clock = Date.UTC(2026, 0, 1);
  const parts = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`part-${i}`, prose(400, i + 1)]));
  const state = () => ({ data: { parts: { ...parts } }, parts: { ...parts } });

  // Kept: every version is named, so none is thinned and the index really holds 1,000.
  const kept = createHistory({ dir: `${dir}/kept`, now: () => clock });
  const saving = await ms(() => { for (let i = 0; i < versions; i++) { clock += HOUR; parts[`part-${i % 50}`] = prose(400, 1000 + i); kept.save('doc', { ...state(), named: true, label: `v${i}` }); } });
  if (kept.list('doc').length !== versions) throw new Error('expected 1,000 versions');
  row('history: save 1,000 versions (all kept)', round(saving), 'ms');
  row('history: save 1,000 versions (all kept)', round(saving / versions), 'ms/save');
  const listing = await ms(() => { for (let i = 0; i < 100; i++) kept.list('doc'); });
  row('history: list 1,000 versions', round(listing / 100), 'ms');
  const reading = await ms(() => { for (let i = 0; i < 200; i++) kept.read('doc', 1 + (i * 37) % versions); });
  row('history: read one version of 1,000', round(reading / 200), 'ms');
  const restoring = await ms(() => { for (let i = 0; i < 20; i++) { clock += HOUR; kept.restore('doc', 10 + i * 40, { current: state() }); } });
  row('history: restore a version (1,000 in the index)', round(restoring / 20), 'ms');
  const index = kept.list('doc').reverse();
  const pruning = await ms(() => { for (let i = 0; i < 100; i++) prunable(index.map(v => ({ ...v, named: false })), { now: clock + 40 * 24 * HOUR, maxBytes: 1e6 }); });
  row('history: one pruning pass over 1,000 versions', round(pruning / 100), 'ms');

  // Thinned: automatic saves, so old ones go as new ones arrive.
  const thinned = createHistory({ dir: `${dir}/thinned`, now: () => clock });
  const auto = await ms(() => { for (let i = 0; i < versions; i++) { clock += HOUR; parts[`part-${i % 50}`] = prose(400, 5000 + i); thinned.save('doc', state()); } });
  row('history: save 1,000 automatic versions (thinned as they age)', round(auto), 'ms');
  row('history: versions left after thinning', thinned.list('doc').length, 'versions');
});
