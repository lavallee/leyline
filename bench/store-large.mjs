// A conversation of 200 turns of realistic size: what one write costs when the 200th turn
// reports an activity update, and how large the file is. Each update is written at once
// (saveDelay 0, then a wait for the disk), so the figure is the cost of one write, not of
// a batch. Also: a burst of sends, each of which is written before it resolves.
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createConversationStore } from '../server/conversations.mjs';
import { bench, ms, round, turnOfRealisticSize } from './lib.mjs';

await bench(async ({ dir, row }) => {
  await writeFile(path.join(dir, 'doc.json'), JSON.stringify({ key: 'doc', turns: Array.from({ length: 199 }, (_, i) => turnOfRealisticSize(i)) }, null, 2));
  const updates = 200, pause = () => new Promise(resolve => setTimeout(resolve, 1));
  let writing = 0;
  const store = createConversationStore({ dir, saveDelay: 0, run: async (turn, lane, signal, tools) => {
    if (turn.user !== 'measure') return { message: 'ok' };
    writing = await ms(async () => {
      for (let i = 0; i < updates; i++) {
        tools.activity({ id: `r${i % 12}`, kind: 'reasoning', append: 'Reading the next paragraph of the draft. ', status: 'running' });
        await pause(); await store.flush();
      }
    });
    return { message: 'Done.' };
  } });
  const opening = await ms(() => store.open('doc'));
  const idle = await ms(async () => { for (let i = 0; i < updates; i++) await pause(); });
  const turn = await store.send('doc', { user: 'measure' });
  while (!turn.finishedAt) await pause();
  await store.flush();
  row('store: 200-turn conversation, open', round(opening), 'ms');
  row('store: 200-turn conversation, one activity update written', round(Math.max(0, writing - idle) / updates), 'ms/update');
  row('store: 200-turn conversation, file size', Math.round((await stat(path.join(dir, 'doc.json'))).size / 1024), 'KB');

  // A burst: 150 requests sent to a fresh conversation without waiting for each other.
  const burst = createConversationStore({ dir, maxLanes: 4, run: async () => ({ message: 'ok' }) });
  const sent = 150;
  const took = await ms(async () => {
    const turns = await Promise.all(Array.from({ length: sent }, (_, i) => burst.send('burst', { user: `request ${i}`, note: 'x'.repeat(2000) })));
    while (turns.some(t => !t.finishedAt)) await pause();
    await burst.flush();
  });
  row('store: 150 requests sent at once, all finished and written', round(took), 'ms');
  await store.close(); await burst.close();
});
