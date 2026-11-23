// The one place server code learns what this package is called. A rename changes
// package.json and nothing here: telemetry scope names, temporary-folder prefixes and
// default client names are all derived from it.
import { readFileSync } from 'node:fs';

let pkg = { name: 'unknown-package', version: '0.0.0' };
try { pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')); } catch { /* bundled away from its package.json */ }

export const PACKAGE_NAME = pkg.name;
export const PACKAGE_VERSION = pkg.version;
/** The name without its npm scope: `@scope/thing` is `thing`. */
export const SHORT_NAME = PACKAGE_NAME.replace(/^@[^/]+\//, '');
/** The short name as an identifier, for telemetry attribute names: `thing-kit` is `thing_kit`. */
export const ATTRIBUTE_PREFIX = SHORT_NAME.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
