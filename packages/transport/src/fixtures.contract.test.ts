import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildIndex, loadFixtures, validateFolderLabels } from './fixture-store';

const ROOT = fileURLToPath(new URL('../../../fixtures/paypal/', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    })
    .sort();
}
const jsonFiles = () =>
  walk(ROOT).filter((p) => p.endsWith('.json') && relative(ROOT, p) !== 'index.json');
const SOURCE_DIR = {
  'docs-examples': 'docs-example',
  synthetic: 'synthetic',
  'sandbox-recordings': 'sandbox-recording',
} as const;

// Only a sandbox recording carries a recording time; the other two sets never do (L3).
function assertRecordedAt(folder: keyof typeof SOURCE_DIR, recordedAt: string | null, rel: string) {
  if (folder === 'sandbox-recordings') expect(recordedAt, rel).not.toBeNull();
  else expect(recordedAt, rel).toBeNull();
}

describe('fixture contract (MAINT-5, A-23 first half)', () => {
  it('L3: the recorded_at rule follows the folder, so a real recording does not trip it', () => {
    assertRecordedAt('sandbox-recordings', '2026-10-21T10:00:00Z', 'rec.json');
    assertRecordedAt('synthetic', null, 'syn.json');
    assertRecordedAt('docs-examples', null, 'doc.json');
    expect(() => assertRecordedAt('sandbox-recordings', null, 'rec.json')).toThrow();
    expect(() => assertRecordedAt('synthetic', '2026-10-21T10:00:00Z', 'syn.json')).toThrow();
  });

  it('every fixture file validates and is listed in index.json', async () => {
    const fixtures = await loadFixtures(ROOT);
    const files = jsonFiles();
    expect(fixtures.length).toBe(files.length);
    expect(files.length).toBeGreaterThanOrEqual(60);

    const expected = await buildIndex(ROOT);
    // The committed index must equal the generated one byte for byte; `vitest -u` rewrites it.
    await expect(`${JSON.stringify(expected, null, 2)}\n`).toMatchFileSnapshot(
      join(ROOT, 'index.json'),
    );
    // listed once each, with the real hash of the bytes on disk
    expect(new Set(expected.files.map((e) => e.file)).size).toBe(files.length);
    for (const e of expected.files) {
      const bytes = readFileSync(join(ROOT, e.file));
      expect(e.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('every fixture has a source label that matches its folder', async () => {
    for (const p of jsonFiles()) {
      const rel = relative(ROOT, p);
      const folder = rel.split('/')[0] as keyof typeof SOURCE_DIR;
      expect(Object.keys(SOURCE_DIR), rel).toContain(folder);
      const [f] = await loadFixtures(join(ROOT, folder)).then((all) =>
        all.filter((x) =>
          rel.endsWith(`${x.meta.scenario}__${x.meta.operation}__${x.meta.step}.json`),
        ),
      );
      expect(f, rel).toBeDefined();
      expect(f?.meta.source, rel).toBe(SOURCE_DIR[folder]);
      expect(f?.meta.origin.length, rel).toBeGreaterThan(10);
      assertRecordedAt(folder, f?.meta.recorded_at ?? null, rel);
    }
  });

  it('scenario steps are contiguous from 1 and each file name carries its key', async () => {
    const fixtures = await loadFixtures(ROOT);
    const keys = new Map<string, number[]>();
    for (const f of fixtures) {
      const k = `${f.meta.scenario}|${f.meta.operation}`;
      keys.set(k, [...(keys.get(k) ?? []), f.meta.step]);
    }
    for (const [k, steps] of keys) {
      expect(
        steps.sort((a, b) => a - b),
        k,
      ).toEqual(steps.map((_, i) => i + 1));
    }
    for (const p of jsonFiles()) {
      const f = fixtures.find((x) =>
        p.endsWith(`${x.meta.scenario}__${x.meta.operation}__${x.meta.step}.json`),
      );
      expect(f, p).toBeDefined();
    }
  });

  it('covers the docs examples the lane spec names', async () => {
    const docs = (await loadFixtures(join(ROOT, 'docs-examples'))).map((f) => ({
      op: f.meta.operation,
      status: 'status' in f.response ? f.response.status : 0,
      text: JSON.stringify(f.response),
      scenario: f.meta.scenario,
    }));
    const has = (op: string, status: number, needle = '') =>
      docs.some((d) => d.op === op && d.status === status && d.text.includes(needle));
    expect(has('create_order', 201)).toBe(true); // minimal
    expect(has('create_order', 201, 'payer-action')).toBe(true);
    for (const s of ['CREATED', 'APPROVED', 'COMPLETED'])
      expect(has('get_order', 200, `"status":"${s}"`), s).toBe(true);
    expect(has('capture_order', 201, 'COMPLETED')).toBe(true);
    expect(has('capture_order', 422, 'ORDER_NOT_APPROVED')).toBe(true);
    expect(has('capture_order', 422, 'ORDER_ALREADY_CAPTURED')).toBe(true);
    expect(has('refund_capture', 201)).toBe(true);
    expect(has('get_order', 404, 'RESOURCE_NOT_FOUND')).toBe(true);
    expect(has('capture_order', 409, 'PREVIOUS_REQUEST_IN_PROGRESS')).toBe(true);
    expect(has('oauth_token', 401)).toBe(true);
  });

  it('covers the synthetic scenarios the lane spec names', async () => {
    const names = new Set(
      (await loadFixtures(join(ROOT, 'synthetic'))).map((f) => f.meta.scenario),
    );
    for (const s of [
      'happy',
      'pending_receiving_pref',
      'pending_then_completed',
      'declined',
      'lost_capture_response',
      'capture_202',
      'partial_207',
      'mismatch_amount',
      'mismatch_payee',
      'mismatch_currency',
      'mismatch_custom_id',
      'duplicate_invoice',
      'rate_limited_429',
      'server_500',
    ]) {
      expect(names.has(s), s).toBe(true);
    }
  });

  it('lost_capture_response times out on capture and a later read shows COMPLETED', async () => {
    const all = await loadFixtures(join(ROOT, 'synthetic'));
    const lost = all.filter((f) => f.meta.scenario === 'lost_capture_response');
    const cap1 = lost.find((f) => f.meta.operation === 'capture_order' && f.meta.step === 1);
    expect(cap1?.response).toEqual({ timeout: true });
    const reads = lost.filter((f) => f.meta.operation === 'get_order');
    expect(JSON.stringify(reads.at(-1)?.response)).toContain('"status":"COMPLETED"');
  });

  it('no fixture contains an email, a bearer token, a client id, or a live hostname', () => {
    const live = new RegExp(
      `(api-m|api|api-3t|www|svcs|ipnpb|developer)\\.${['paypal', 'com'].join('\\.')}`,
      'i',
    );
    for (const p of jsonFiles()) {
      const text = readFileSync(p, 'utf8');
      const rel = relative(ROOT, p);
      expect(text, `${rel}: email`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text, `${rel}: bearer`).not.toMatch(/bearer\s+[A-Za-z0-9._~+/=-]{8,}/i);
      expect(text, `${rel}: access token`).not.toMatch(/"(access_token|refresh_token|id_token)"/);
      expect(text, `${rel}: client credential`).not.toMatch(/"?client_(id|secret)"?\s*:/i);
      expect(text, `${rel}: client id shape`).not.toMatch(/\bA[A-Za-z0-9_-]{40,}\b/);
      expect(text, `${rel}: live host`).not.toMatch(live);
      // any paypal host that is left must be a sandbox host
      const hosts = [...text.matchAll(/https?:\/\/([^/"\s?#:]+)/g)].map((m) => m[1] ?? '');
      for (const h of hosts) expect(h.endsWith('.sandbox.paypal.com'), `${rel}: ${h}`).toBe(true);
      // authorization headers hold the placeholder only
      for (const m of text.matchAll(/"authorization":\s*"([^"]*)"/gi)) {
        expect(m[1], rel).toBe('[redacted]');
      }
    }
  });
});

describe('sandbox-recordings folder (B-13)', () => {
  const rec = (over: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}) => ({
    meta: {
      source: 'sandbox-recording',
      scenario: 'spike_happy',
      operation: 'get_order',
      step: 1,
      recorded_at: '2026-10-23T09:30:00Z',
      origin: 'sandbox-recording: owner spike run 1',
      redactions: ['header authorization: replaced'],
      ...metaOver,
    },
    request: { method: 'GET', path_template: '/v2/checkout/orders/{id}', headers: {}, body: null },
    response: { status: 200, headers: {}, body: { id: 'X1', status: 'CREATED' } },
    ...over,
  });
  async function tree(files: Record<string, unknown>): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'umsbx-fxc-'));
    for (const [rel, v] of Object.entries(files)) {
      await mkdir(join(d, rel, '..'), { recursive: true });
      await writeFile(join(d, rel), JSON.stringify(v));
    }
    return d;
  }

  it('the committed tree has no label or recorded_at problem in any folder', async () => {
    expect(await validateFolderLabels(ROOT)).toEqual([]);
  });

  it('accepts a well-formed recording', async () => {
    const d = await tree({ 'sandbox-recordings/spike_happy__get_order__1.json': rec() });
    expect(await validateFolderLabels(d)).toEqual([]);
  });

  it('requires recorded_at non-null in sandbox-recordings', async () => {
    const d = await tree({
      'sandbox-recordings/spike_happy__get_order__1.json': rec({}, { recorded_at: null }),
    });
    await expect(validateFolderLabels(d)).rejects.toThrow(/recorded_at/);
  });

  it('refuses another source label inside sandbox-recordings and a recording elsewhere', async () => {
    const a = await tree({
      'sandbox-recordings/spike_happy__get_order__1.json': rec(
        {},
        { source: 'synthetic', recorded_at: null },
      ),
    });
    expect((await validateFolderLabels(a)).join('|')).toMatch(
      /sandbox-recordings.*sandbox-recording/,
    );
    const b = await tree({ 'synthetic/spike_happy__get_order__1.json': rec() });
    expect((await validateFolderLabels(b)).join('|')).toMatch(/synthetic/);
  });

  it('requires an origin text and a redactions list in sandbox-recordings', async () => {
    const a = await tree({
      'sandbox-recordings/spike_happy__get_order__1.json': rec({}, { origin: 'x' }),
    });
    expect((await validateFolderLabels(a)).join('|')).toMatch(/origin/);
    const b = await tree({
      'sandbox-recordings/spike_happy__get_order__1.json': rec({}, { redactions: [] }),
    });
    expect((await validateFolderLabels(b)).join('|')).toMatch(/redactions/);
  });

  it('keeps the other folders strict: a docs-example or synthetic file with recorded_at is refused', async () => {
    for (const folder of ['docs-examples', 'synthetic'] as const) {
      const src = folder === 'docs-examples' ? 'docs-example' : 'synthetic';
      const d = await tree({
        [`${folder}/spike_happy__get_order__1.json`]: rec({}, { source: src }),
      });
      await expect(validateFolderLabels(d)).rejects.toThrow(/recorded_at/);
    }
  });
});
