// Appending N activity updates to a running turn, with the store's default settings.
// The updates arrive one per event-loop turn, as a provider's stream would deliver them,
// and the time runs from send() to the last write reaching the disk.
import { createConversationStore } from '../server/conversations.mjs';
import { bench, ms, perSec, round } from './lib.mjs';

const count = Number(process.argv[2] || 1000);
await bench(async ({ dir, row }) => {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const store = createConversationStore({ dir, run: async (turn, lane, signal, tools) => {
    for (let i = 0; i < count; i++) {
      tools.activity(i % 4 === 0 ? { id: `c${i % 120}`, kind: 'activity', command: `ls notes/${i}`, status: 'done', output: 'a.md\nb.md\nc.md' }
        : { id: `r${i % 40}`, kind: 'reasoning', append: 'Reading the next paragraph of the draft. ', status: 'running' });
      await tick();
    }
    return { message: 'Done.' };
  } });
  const took = await ms(async () => {
    const turn = await store.send('doc', { user: 'Tidy this' });
    while (!turn.finishedAt) await tick();
    await store.flush();
  });
  await store.close();
  const name = `store: ${count.toLocaleString('en')} activity update${count === 1 ? '' : 's'} on a running turn`;
  row(name, round(took), 'ms');
  if (count >= 100) row(name, perSec(count, took), 'updates/s');
});
