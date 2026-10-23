// Usage: node --import ./scripts/lib/ts-register.mjs scripts/<entry>.mjs
// Only for scripts that never load the sandbox config: the flag stays in process.execArgv. Scripts
// that read the config start as a plain `node scripts/<entry>.mjs` and call registerTs() instead.
import { registerTs } from './register-ts.mjs';

registerTs();
