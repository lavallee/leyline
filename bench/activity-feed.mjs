// The activity feed with 100,000 entries kept and ten readers. Each reader asks what is
// new after every 100 events and acknowledges it, as a conversation does at each turn.
import { createActivityFeed } from '../server/activity.mjs';
import { bench, ms, perSec, round } from './lib.mjs';

await bench(async ({ row }) => {
  const count = 100000, readers = 10;
  for (const [keep, label] of [[100000, '100,000 entries kept'], [1000, 'default keep (1,000)']]) {
    const feed = createActivityFeed({ keep });
    for (let r = 0; r < readers; r++) feed.pending(`reader-${r}`, 'doc');
    let told = 0;
    const took = await ms(() => {
      for (let i = 0; i < count; i++) {
        feed.changed('doc', [{ id: `part-${i % 500}`, change: 'updated', before: i, after: i + 1 }]);
        if (i % 100 === 99) for (let r = 0; r < readers; r++) { const { events, upto } = feed.pending(`reader-${r}`, 'doc'); told += events.length; feed.ack(`reader-${r}`, upto, events); }
      }
    });
    if (told !== count * readers) throw new Error(`readers were told ${told} events, expected ${count * readers}`);
    row(`activity: 100,000 events, 10 readers, ${label}`, round(took), 'ms');
    row(`activity: 100,000 events, 10 readers, ${label}`, perSec(count, took), 'events/s');
  }
});
