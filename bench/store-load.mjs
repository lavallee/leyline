// Opening a store directory that holds 1,000 conversations of ten turns each. One in ten
// was left with a running turn, so recovery (and the write that records it) is in the figure.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createConversationStore } from '../server/conversations.mjs';
import { bench, ms, round, turnOfRealisticSize } from './lib.mjs';

const count = 1000;
await bench(async ({ dir, row }) => {
  for (let c = 0; c < count; c++) {
    const turns = Array.from({ length: 10 }, (_, i) => turnOfRealisticSize(c * 10 + i));
    if (c % 10 === 0) Object.assign(turns.at(-1), { status: 'running', finishedAt: undefined });
    await writeFile(path.join(dir, `doc-${c}.json`), JSON.stringify({ key: `doc-${c}`, turns }, null, 2));
  }
  const store = createConversationStore({ dir, run: async () => ({ message: '' }) });
  let turns = 0;
  const took = await ms(async () => { for (let c = 0; c < count; c++) turns += (await store.open(`doc-${c}`)).turns.length; await store.flush(); });
  if (turns !== count * 10) throw new Error(`expected ${count * 10} turns, read ${turns}`);
  row('store: open 1,000 conversations (10 turns each, 100 recovered)', round(took), 'ms');
  row('store: open 1,000 conversations (10 turns each, 100 recovered)', round(took / count), 'ms/conversation');
  const other = createConversationStore({ dir, run: async () => ({ message: '' }) });
  const together = await ms(async () => { await Promise.all(Array.from({ length: count }, (_, c) => other.open(`doc-${c}`))); });
  row('store: open 1,000 conversations at once', round(together), 'ms');
});
