// Operator entry points for pnpm safety:status, safety:stop, safety:approve and safety:resume.
//   node --env-file-if-exists=.env.local scripts/safety-cli.mjs <command> [options]
// The commands and options are described in scripts/lib/safety-cli-main.mjs.
//
// A plain node process (BU-6): the TypeScript hooks are registered here, in-process, and the body is
// imported afterwards. Do not start it with --import, --require or --conditions: in sandbox mode the
// config guard refuses those flags (transport_env_override), which is why the old launcher
// (`--import ./scripts/lib/ts-register.mjs`) could not run against a sandbox config.
import { registerTs } from './lib/register-ts.mjs';

registerTs();
await import('./lib/safety-cli-main.mjs');
