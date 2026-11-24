// proposals.make on a 1 MB document: 500 edits, each replacing text that occurs once.
// Then the awkward cases a model can produce: text that occurs everywhere.
import { createProposals } from '../server/proposals.mjs';
import { bench, ms, round, prose } from './lib.mjs';

await bench(async ({ row }) => {
  const edits = 500, block = Math.floor(1_000_000 / edits);
  let body = '';
  for (let i = 0; i < edits; i++) body += `[[marker ${String(i).padStart(4, '0')}]] ` + prose(block - 17, i + 1) + '\n';
  const proposals = createProposals({ maxPerTurn: edits });
  const turn = { id: 't' };
  let doc = { 'draft.md': body }, made = 0;
  const took = await ms(() => {
    // Back to front and front to back alternately, as an agent working through a draft does not go in order.
    for (let n = 0; n < edits; n++) {
      const i = n % 2 ? edits - n : n;
      const result = proposals.make(turn, { file: 'draft.md', find: `[[marker ${String(i).padStart(4, '0')}]] `, replace: `(revised ${i}) `, reason: 'bench' }, doc);
      if (result.ok) { made++; doc = result.doc; }
    }
  });
  if (made !== edits) throw new Error(`expected ${edits} edits to apply, ${made} did`);
  row(`proposals: make ${edits} edits on a 1 MB document`, round(took), 'ms');
  row(`proposals: make ${edits} edits on a 1 MB document`, round(took / edits), 'ms/edit');
  const undo = await ms(() => { doc = proposals.undoRequest(turn, doc).doc; });
  if (doc['draft.md'] !== body) throw new Error('undoing every edit did not give the document back');
  row(`proposals: undo all ${edits} edits`, round(undo), 'ms');

  const same = { 'a.md': 'a'.repeat(1_000_000) };
  const one = await ms(() => { const r = createProposals().make({ id: 'x' }, { file: 'a.md', find: 'a', replace: 'b' }, same); if (r.code !== 'ambiguous') throw new Error(r.code); });
  row('proposals: refuse a one-letter find that occurs a million times', round(one), 'ms');
  const long = await ms(() => { const r = createProposals().make({ id: 'x' }, { file: 'a.md', find: 'a'.repeat(2000), replace: 'b' }, same); if (r.code !== 'ambiguous') throw new Error(r.code); });
  row('proposals: refuse a 2,000-letter find that occurs a million times', round(long), 'ms');
});
