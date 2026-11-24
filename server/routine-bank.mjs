import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
// Storage and override order shared by canvas JavaScript routines and page
// prompt routines. Hosts retain their own parsers, validation and execution.
//
// A file that cannot be parsed, or does not hold a routine (an object with `code` as
// text), is left out of the list and reported to `onError`: one bad file must not take
// the whole menu down. A routine's name is always its file's name.
export function createRoutineBank({ shipped, banked, extension, parse, compose, onError = () => {} }) {
  const scan = (dir, source) => {
    const found = [];
    for (const f of dir && existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(extension)) : []) {
      const name = f.slice(0, -extension.length);
      try {
        const routine = parse(name, readFileSync(join(dir, f), 'utf8'));
        if (!routine || typeof routine !== 'object' || Array.isArray(routine) || typeof routine.code !== 'string') throw new Error('it does not hold a routine');
        found.push({ ...routine, name, title: typeof routine.title === 'string' && routine.title ? routine.title : name, source });
      } catch (error) { try { onError(Object.assign(new Error(`${join(dir, f)} was left out: ${String(error?.message ?? error).slice(0, 200)}`), { code: 'invalid', file: join(dir, f) })); } catch { /* a host's handler must not break the menu */ } }
    }
    return found;
  };
  const valid = name => { if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid routine name.'); };
  return {
    list() { return [...new Map([...scan(shipped, 'shipped'), ...scan(banked, 'banked')].map(r => [r.name, r])).values()].sort((a,b) => a.title.localeCompare(b.title)); },
    save(name, parts) { valid(name); mkdirSync(banked, { recursive: true, mode: 0o700 }); const file = join(banked, name + extension); writeFileSync(file + '.tmp', compose(parts), { mode: 0o600 }); renameSync(file + '.tmp', file); return parse(name, readFileSync(file, 'utf8')); },
  };
}
