// INT-CTL / CTL.2: the pasted `cloud status --json`. It is validated in the browser against CloudStatusSchema
// (strict, at most 16 KB) and never stored or posted. Anything else is refused with a plain message that does not
// repeat the pasted text; the project becomes part of a link, so it must match the project id pattern.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloudStatusSchema } from '@umsbx/contracts';
import { parseCloudStatus } from './lib/services-view';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..', '..');
const fixtureText = readFileSync(
  join(root, 'scripts', '__fixtures__', 'cloud-status.json'),
  'utf8',
);
const doc = (): Record<string, unknown> => JSON.parse(fixtureText) as Record<string, unknown>;
const withService = (i: number, over: Record<string, unknown>) => {
  const d = doc();
  const s = (d['services'] as Record<string, unknown>[]).slice();
  s[i] = { ...s[i], ...over };
  return { ...d, services: s };
};
const refused = (text: string): string => {
  const r = parseCloudStatus(text);
  expect(r.ok, text.slice(0, 80)).toBe(false);
  return r.ok ? '' : r.message;
};

describe('the schema', () => {
  it("accepts CL1's fixture and holds the project pattern of F10", () => {
    expect(CloudStatusSchema.safeParse(doc()).success).toBe(true);
    for (const p of ['unitmarket-sbx-vr1', 'abcde', 'a1234-b5678']) {
      expect(CloudStatusSchema.safeParse({ ...doc(), project: p }).success, p).toBe(true);
    }
    for (const p of ['Abcde', 'abcd', '1bcde', 'abcde-', 'a'.repeat(31), 'ab cde', 'abc_de', '']) {
      expect(CloudStatusSchema.safeParse({ ...doc(), project: p }).success, p).toBe(false);
    }
  });
});

describe('what is refused, with a plain message', () => {
  it('markup and text that is not JSON', () => {
    for (const t of ['<script>alert(1)</script>', '', 'hello', '{', '[]', 'null', '"x"'])
      expect(refused(t)).toMatch(/\S/);
  });

  it('the message never repeats the pasted text', () => {
    const m = refused('<script>alert("pwned-canary")</script>');
    expect(m).not.toContain('script');
    expect(m).not.toContain('pwned-canary');
    expect(m).not.toMatch(/[<>]/);
  });

  it('extra fields at the top and inside a service', () => {
    refused(JSON.stringify({ ...doc(), extra: 1 }));
    refused(JSON.stringify(withService(0, { token: 'abc' })));
    refused(JSON.stringify(withService(4, { approval_ref: 'DL-1' })));
  });

  it('a bad enum, a missing part, a part out of order and a wrong type', () => {
    refused(JSON.stringify(withService(0, { state: 'sleeping' })));
    refused(JSON.stringify(withService(4, { state: 'up' })));
    refused(JSON.stringify(withService(4, { flag: 'maybe' })));
    refused(JSON.stringify({ ...doc(), services: (doc()['services'] as unknown[]).slice(0, 4) }));
    refused(
      JSON.stringify({ ...doc(), services: [...(doc()['services'] as unknown[])].reverse() }),
    );
    refused(JSON.stringify(withService(0, { last_changed_at: 12 })));
    refused(JSON.stringify(withService(0, { url: 'javascript:alert(1)' })));
  });

  it('a project that would break out of a link', () => {
    for (const project of [
      'javascript:alert(1)',
      'my"project',
      'a/b/c/d/e',
      'proj?x=1',
      'proj#frag',
      'p\nq-abc',
    ])
      refused(JSON.stringify({ ...doc(), project }));
  });

  it('more than 16 KB, even when it is valid JSON', () => {
    const big = JSON.stringify(withService(0, { last_error: 'x'.repeat(17 * 1024) }));
    expect(big.length).toBeGreaterThan(16 * 1024);
    expect(refused(big)).toMatch(/16/);
    const pad = fixtureText + ' '.repeat(16 * 1024);
    refused(pad);
  });
});

describe('the sources hold no injection or network path', () => {
  const strip = (f: string) =>
    readFileSync(join(here, f), 'utf8')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/\/\*[\s\S]*?\*\//g, '');
  it('ServicesPanel.tsx and services-view.ts hold no dangerouslySetInnerHTML, innerHTML, fetch( or method: POST', () => {
    for (const f of ['ui/ops/ServicesPanel.tsx', 'lib/services-view.ts']) {
      expect(strip(f), f).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|fetch\(|method:\s*'POST'|localStorage|sessionStorage/,
      );
    }
  });
  it('the only builder of console links is services-view.ts, and it encodes the project', () => {
    const src = strip('lib/services-view.ts');
    expect(src).toContain('https://console.cloud.google.com/');
    expect(src).toContain('encodeURIComponent(');
    expect(strip('ui/ops/ServicesPanel.tsx')).not.toContain('console.cloud.google.com');
  });
});
