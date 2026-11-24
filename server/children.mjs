// Child processes this package starts: stopping one for certain, and not leaving any
// behind when the host process exits.
//
// What this can and cannot do: a child is asked to stop (SIGTERM) and, if it has not gone
// within a grace period, killed (SIGKILL). When the host process exits normally, or calls
// process.exit, every child still running is sent SIGTERM. A host that is itself killed by
// a signal runs no code, so its children then see only their stdin close.
const live = new Set();
let hooked = false;

/** Remembers a child so it is asked to stop if the host process exits first. */
export function track(child) {
  if (!hooked) {
    hooked = true;
    process.on('exit', () => { for (const c of live) try { c.kill('SIGTERM'); } catch { /* already gone */ } });
  }
  live.add(child);
  const gone = () => live.delete(child);
  child.once('exit', gone);
  child.once('error', () => { if (!child.pid) gone(); });
  return child;
}

const exited = child => child.exitCode !== null || child.signalCode !== null;

/** Asks a child to stop, and kills it if it is still there after `grace` milliseconds. */
export function terminate(child, grace = 2000) {
  if (!child || !child.pid || exited(child)) return;
  try { child.kill('SIGTERM'); } catch { return; }
  const timer = setTimeout(() => { if (!exited(child)) try { child.kill('SIGKILL'); } catch { /* gone */ } }, grace);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
}

/** How many tracked children are still running. For tests and diagnostics. */
export const liveChildren = () => live.size;
