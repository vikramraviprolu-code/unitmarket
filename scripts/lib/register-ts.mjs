// Registers the TypeScript module hooks (ts-hooks.mjs) inside the running process.
//
// Why not `node --import ./scripts/lib/ts-register.mjs`: that flag stays in process.execArgv, and in
// sandbox mode packages/config and the production Wire refuse `--import`, `--require` and
// `--conditions` on purpose (transport_env_override). A script that loads the sandbox config must
// start as a plain `node scripts/<entry>.mjs`, call registerTs() first, and only then import the
// TypeScript sources with a dynamic import(). The guard is not relaxed anywhere (BU-6).
import { register } from 'node:module';

let done = false;
export function registerTs() {
  if (done) return;
  done = true;
  register('./ts-hooks.mjs', import.meta.url);
}
