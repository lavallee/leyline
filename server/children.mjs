// Child processes this package starts: stopping one for certain, and not leaving any
// behind when the host process exits.
//
// What this can and cannot do: a child is asked to stop (SIGTERM) and, if it has not gone
// within a grace period, killed (SIGKILL). When the host process exits normally, or calls
// process.exit, every child still running is sent SIGTERM. A host that is itself killed by
// a signal runs no code, so its children then see only their stdin close.
const live = new Set();
const grouped = new WeakSet();   // children that lead a process group of their own
let hooked = false;

/** Remembers a child so it is asked to stop if the host process exits first. */
export function track(child, { group = false } = {}) {
  if (group) grouped.add(child);
  if (!hooked) {
    hooked = true;
    process.on('exit', () => { for (const c of live) try { if (grouped.has(c)) process.kill(-c.pid, 'SIGTERM'); else c.kill('SIGTERM'); } catch { /* already gone */ } });
  }
  live.add(child);
  const gone = () => live.delete(child);
  child.once('exit', gone);
  child.once('error', () => { if (!child.pid) gone(); });
  return child;
}

const exited = child => child.exitCode !== null || child.signalCode !== null;

/**
 * Asks a child to stop, and kills it if it is still there after `grace` milliseconds.
 * With `group` (for a child spawned `detached`, so that it leads a process group of its
 * own) both signals go to the whole group: the child and everything it started. The
 * SIGKILL is then sent to the group even when the child itself has gone, since what it
 * started may not have.
 */
export function terminate(child, grace = 2000, { group = false } = {}) {
  if (!child || !child.pid) return;
  const signal = name => { try { if (group) process.kill(-child.pid, name); else child.kill(name); return true; } catch { return false; } };
  if (!group && exited(child)) return;
  if (!signal('SIGTERM')) return;
  const timer = setTimeout(() => { if (group || !exited(child)) signal('SIGKILL'); }, grace);
  timer.unref?.();
  if (!group) child.once('exit', () => clearTimeout(timer));
}

/** How many tracked children are still running. For tests and diagnostics. */
export const liveChildren = () => live.size;
