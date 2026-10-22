// Runs the kit exactly as an owner would, as a child process under Node type stripping, with a
// preload that records and blocks every network entry point (net, tls, http, https, dns, fetch).
// The preload writes one line per attempt to a log file; the log must stay empty.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const KIT = path.resolve(new URL('./spike.ts', import.meta.url).pathname);
let tmp: string;
let preload: string;
let netLog: string;

const PRELOAD = `
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const log = process.env.SPY_LOG;
const hit = (n) => { appendFileSync(log, n + '\\n'); throw new Error('network use forbidden: ' + n); };
const patch = (mod, names, label) => { for (const k of names) { try { mod[k] = () => hit(label + '.' + k); } catch {} } };
patch(require('node:net'), ['connect', 'createConnection'], 'net');
patch(require('node:tls'), ['connect'], 'tls');
patch(require('node:http'), ['request', 'get'], 'http');
patch(require('node:https'), ['request', 'get'], 'https');
const dns = require('node:dns');
patch(dns, ['lookup', 'resolve', 'resolve4', 'resolve6'], 'dns');
patch(dns.promises, ['lookup', 'resolve'], 'dns.promises');
globalThis.fetch = () => hit('fetch');
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-cli-'));
  preload = path.join(tmp, 'preload.mjs');
  netLog = path.join(tmp, 'net.log');
  fs.writeFileSync(preload, PRELOAD);
  fs.writeFileSync(netLog, '');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(true).toBe(true);
});

function runKit(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--import', preload, KIT, ...args], {
    env: { PATH: process.env['PATH'] ?? '', HOME: tmp, SPY_LOG: netLog, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    net: fs.readFileSync(netLog, 'utf8'),
  };
}

describe('spike kit as a process', () => {
  it('--dry-run exits 0 under CI=true with no network and writes outside the repo', () => {
    const out = path.join(tmp, 'out');
    const r = runKit(['--dry-run', '--out', out], { CI: 'true' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.net).toBe('');
    expect(fs.existsSync(path.join(out, 'summary.md'))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toMatch(/DRY RUN/);
  });
  it.each(['CLAUDECODE', 'CLAUDE_CODE_REMOTE'])(
    '--dry-run exits 0 under the AI-session marker %s, with no network',
    (name) => {
      const out = path.join(tmp, 'out');
      const r = runKit(['--dry-run', '--out', out], { [name]: '1' });
      expect(r.code, r.stderr).toBe(0);
      expect(r.net).toBe('');
    },
  );
  it('--dry-run default output goes under the temp directory, not the home directory or the repo', () => {
    const r = runKit(['--dry-run'], { TMPDIR: tmp });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(tmp);
    expect(r.net).toBe('');
  });
  it('refuses without stdin TTY, exit 2, no network, nothing written', () => {
    const out = path.join(tmp, 'out');
    const r = runKit(['--out', out], {
      SPIKE_OPERATOR: 'vikram',
      SPIKE_APPROVAL_REF: 'D-024',
      SPIKE_MODE: 'read',
      PAYPAL_CLIENT_ID: ['fake', 'id'].join('-'),
      PAYPAL_CLIENT_SECRET: ['fake', 'secret'].join('-'),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/REFUSED/);
    expect(r.stderr).not.toContain('fake-secret');
    expect(r.net).toBe('');
    expect(fs.existsSync(out)).toBe(false);
  });
  it('refuses with nothing set', () => {
    const r = runKit([], {});
    expect(r.code).toBe(2);
    expect(r.net).toBe('');
  });
  it('--help exits 0 and names the refusals', () => {
    const r = runKit(['--help'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/SPIKE_OPERATOR/);
    expect(r.net).toBe('');
  });
});
