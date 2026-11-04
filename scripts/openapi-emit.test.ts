// API-W0 (F1): scripts/openapi-emit.mjs writes docs/api/openapi-v1.json from the zod contracts, and
// --check fails when the committed file is stale. CI runs --check (package.json check:openapi).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'openapi-emit.mjs');
const FILE = join(REPO_ROOT, 'docs', 'api', 'openapi-v1.json');
const run = (...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    ['--import', join(REPO_ROOT, 'scripts', 'lib', 'ts-register.mjs'), SCRIPT, ...args],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('openapi-emit', () => {
  it('the committed docs/api/openapi-v1.json is current (--check exits 0)', () => {
    const r = run('--check');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('openapi: ok');
  });

  it('the committed document is OpenAPI 3.1 and has the api-keys paths', () => {
    const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/v1/api-keys', '/api/v1/api-keys/{id}']),
    );
    expect(JSON.stringify(doc)).not.toMatch(/https?:\/\//);
  });

  it('--check fails and names the file when the committed document differs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'openapi-'));
    mkdirSync(join(tmp, 'docs', 'api'), { recursive: true });
    cpSync(FILE, join(tmp, 'docs', 'api', 'openapi-v1.json'));
    writeFileSync(join(tmp, 'docs', 'api', 'openapi-v1.json'), '{"openapi":"3.1.0","paths":{}}\n');
    const r = run('--check', '--out', join(tmp, 'docs', 'api', 'openapi-v1.json'));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/openapi-v1\.json/);
    expect(r.out).toMatch(/stale|differs|pnpm/);
  });

  it('--out writes the document and a second run writes the same bytes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'openapi-'));
    const out = join(tmp, 'a.json');
    expect(run('--out', out).status).toBe(0);
    const first = readFileSync(out, 'utf8');
    expect(run('--out', out).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(first);
    expect(first).toBe(readFileSync(FILE, 'utf8'));
    expect(first.endsWith('\n')).toBe(true);
    expect(existsSync(out)).toBe(true);
  });

  it('check:openapi is part of the ci script and has its own script entry', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:openapi']).toMatch(/openapi-emit\.mjs --check/);
    expect(pkg.scripts['ci']).toContain('check:openapi');
  });
});
