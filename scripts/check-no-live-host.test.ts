import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materialize, runGuard } from './test-helpers';

const GUARD = 'check-no-live-host.mjs';

describe('check-no-live-host', () => {
  it.each([
    ['bad-api-m', 'packages/paypal/src/client.ts'],
    ['bad-api', 'src/x.ts'],
    ['bad-ipn', 'src/ipn.ts'],
    ['bad-json-fixture', 'packages/testkit/fixtures/order.json'],
    ['bad-docs-outside-allowlist', 'docs/notes.md'],
  ])('fails on a live hostname in %s', (name, file) => {
    const r = runGuard(GUARD, materialize(`live-host/${name}`));
    expect(r.status).toBe(1);
    expect(r.out).toContain(file);
    expect(r.out).toMatch(/live PayPal hostname/);
  });

  it('fails on the sandbox hostname outside the one constant module', () => {
    const r = runGuard(GUARD, materialize('live-host/bad-sandbox-outside-constant'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/other.ts');
    expect(r.out).toMatch(/sandbox hostname outside/);
  });

  it('passes when the sandbox host is only in endpoints.ts and live names only in docs/design', () => {
    const r = runGuard(GUARD, materialize('live-host/good'));
    expect(r.out).toContain('check-no-live-host: ok');
    expect(r.status).toBe(0);
  });

  it('allows the sandbox host in the spike kit file only (B-L6)', () => {
    const sandbox = ['https://api-m', 'sandbox', 'paypal', 'com'].join('.');
    const src = `export const SANDBOX_API = '${sandbox}';\n`;
    const root = mkdtempSync(join(tmpdir(), 'live-host-'));
    for (const rel of ['tools/spike-kit/src/spike.ts', 'tools/spike-kit/src/other.ts']) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), src);
    }
    const r = runGuard(GUARD, root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('tools/spike-kit/src/other.ts');
    expect(r.out).not.toContain('spike-kit/src/spike.ts');
  });

  it('passes on the clean repository', () => {
    const r = runGuard(GUARD);
    expect(r.out).toContain('check-no-live-host: ok');
    expect(r.status).toBe(0);
  });

  // Review L1: spellings the plain-text scan missed.
  describe('obfuscated hostnames', () => {
    const P = ['paypal', 'com'];
    const put = (rel: string, text: string): string => {
      const root = mkdtempSync(join(tmpdir(), 'live-host-'));
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
      return root;
    };
    it.each([
      ['fullwidth dots', 'src/a.ts', `export const u = '${['api-m', ...P].join('\uFF0E')}';\n`],
      [
        'ideographic full stop',
        'src/a.ts',
        `export const u = '${['api-m', ...P].join('\u3002')}';\n`,
      ],
      [
        'json unicode escapes',
        'fixtures/a.json',
        `{"u":"https://api-m\\u002e${P.join('\\u002e')}/v1"}\n`,
      ],
      ['json escaped letters', 'fixtures/a.json', `{"u":"\\u0061pi-m.${P.join('.')}"}\n`],
      ['percent-encoded dots', 'src/a.ts', `export const u = 'https://www%2E${P.join('%2E')}/';\n`],
      ['fullwidth letters', 'src/a.ts', `export const u = '${'ａｐｉ-ｍ'}.${P.join('.')}';\n`],
    ])('fails on %s', (_n, rel, text) => {
      const r = runGuard(GUARD, put(rel, text));
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/live PayPal hostname/);
    });

    it('treats api.sandbox like the other sandbox hosts: only the constant module may name it', () => {
      const host = ['api', 'sandbox', ...P].join('.');
      const r = runGuard(GUARD, put('src/a.ts', `export const u = '${host}';\n`));
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/sandbox hostname outside/);
      const full = ['api-m', 'sandbox', ...P].join('\uFF0E');
      const r2 = runGuard(GUARD, put('src/b.ts', `export const u = '${full}';\n`));
      expect(r2.status).toBe(1);
    });
  });
});
