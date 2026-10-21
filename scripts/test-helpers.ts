// Test helpers for the guard scripts. Fixtures under scripts/__fixtures__ are inert: files carry a
// `.fixture` suffix and forbidden strings appear as {{TOKENS}}. A test copies a fixture directory
// into a temporary directory, strips the suffix and fills the tokens, then runs a guard on it.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(REPO_ROOT, 'scripts', '__fixtures__');

// Forbidden strings are assembled here at run time so no source file contains them.
export const TOKENS: Record<string, string> = {
  LIVE_API_M: 'api-m.' + 'paypal.com',
  LIVE_API: 'api.' + 'paypal.com',
  LIVE_WWW_IPN: 'www.' + 'paypal.com/ipn',
  SANDBOX_HOST: 'api-m.sandbox.' + 'paypal.com',
  SIM_REPO: 'AIC_Hackathon_' + 'UnitMarket',
  SIM_SCOPE: '@unitmarket-' + 'sim',
  PUB: 'NEXT_' + 'PUBLIC',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Copy scripts/__fixtures__/<name> to a temp dir, strip `.fixture`, fill tokens. Returns the dir. */
export function materialize(name: string): string {
  const src = join(FIXTURES, name);
  const dst = mkdtempSync(join(tmpdir(), 'sbx-fixture-'));
  cpSync(src, dst, { recursive: true });
  for (const file of walk(dst)) {
    if (!file.endsWith('.fixture')) continue;
    let text = readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(TOKENS)) text = text.split(`{{${k}}}`).join(v);
    const target = file.slice(0, -'.fixture'.length);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    rmSync(file);
  }
  return dst;
}

export interface GuardResult {
  status: number | null;
  out: string;
}

/** Run a guard script. With `root` it scans that directory, otherwise the repository itself. */
export function runGuard(script: string, root?: string): GuardResult {
  const args = [join(REPO_ROOT, 'scripts', script), ...(root ? ['--root', root] : [])];
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
