// Operator entry point for pnpm privacy:export and pnpm privacy:delete (OPS-PRIV, PRIV-3 and PRIV-4).
//   node --env-file-if-exists=.env.local scripts/privacy.mjs export <buyer_id>
//   node --env-file-if-exists=.env.local scripts/privacy.mjs delete <buyer_id> --operator <id> --reason <text>
// The commands are described in scripts/lib/privacy-main.mjs and docs/specs/ops-privacy-export-delete.md.
//
// A plain node process (BU-6): the TypeScript hooks are registered here, in-process, and the body is
// imported afterwards. Do not start it with --import, --require or --conditions.
import { registerTs } from './lib/register-ts.mjs';

registerTs();
await import('./lib/privacy-main.mjs');
