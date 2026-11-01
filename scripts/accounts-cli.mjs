// Operator entry point for pnpm accounts:reset-password (ID-ACCOUNTS): the lost password path.
//   node --env-file-if-exists=.env.local scripts/accounts-cli.mjs --username <name> [--operator <id>]
// The body is scripts/lib/accounts-cli-main.mjs. A plain node process (BU-6): the TypeScript hooks are
// registered here, in-process, and the body is imported afterwards. Do not start it with --import,
// --require or --conditions.
import { registerTs } from './lib/register-ts.mjs';

registerTs();
await import('./lib/accounts-cli-main.mjs');
