import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRecordings, formatSummary, residueRule, writeRecordings } from './recorder';
import { recorderSelfTest } from './recorder-selftest';
import type { BuildResult } from './recorder';
import { FixtureFileSchema } from './fixture-schema';
import { buildIndex } from './fixture-store';
import { exchange, hostileExchange, host, liveInputs, makeCanaries } from './recorder-corpus';

const OPTS = {
  recorded_at: '2026-10-23T09:30:00Z',
  origin: 'sandbox-recording: owner spike run 1, raw outputs already redacted by hand',
};
const ok = (r: BuildResult) => {
  if (!r.ok) throw new Error(`refused: ${r.refusal.code} ${r.refusal.where}`);
  return r;
};
const textOf = (r: BuildResult) =>
  ok(r)
    .files.map((f) => f.text)
    .join('\n');

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'umsbx-rec-'));
  await mkdir(join(root, 'fixtures', 'paypal', 'synthetic'), { recursive: true });
  return root;
}

describe('recorder output shape', () => {
  it('builds a sandbox-recording fixture that passes the schema', async () => {
    const r = ok(await buildRecordings([exchange()], OPTS));
    expect(r.files.map((f) => f.name)).toEqual(['spike_happy__get_order__1.json']);
    const fx = FixtureFileSchema.parse(JSON.parse(r.files[0]!.text));
    expect(fx.meta.source).toBe('sandbox-recording');
    expect(fx.meta.recorded_at).toBe(OPTS.recorded_at);
    expect(fx.meta.origin).toContain('owner spike');
    expect(Array.isArray(fx.meta.redactions)).toBe(true);
    expect(fx.meta.redactions.length).toBeGreaterThan(0);
    expect(fx.request.path_template).toBe('/v2/checkout/orders/{id}');
    expect(fx.meta.expected_id).toBe('5O190127TN364715T');
  });

  it('numbers steps per scenario and operation in input order', async () => {
    const r = ok(
      await buildRecordings(
        [
          exchange(),
          exchange(),
          exchange({
            operation: 'capture_order',
            request: {
              method: 'POST',
              path: '/v2/checkout/orders/5O190127TN364715T/capture',
              headers: {},
              body: null,
            },
          }),
        ],
        OPTS,
      ),
    );
    expect(r.files.map((f) => f.name)).toEqual([
      'spike_happy__get_order__1.json',
      'spike_happy__get_order__2.json',
      'spike_happy__capture_order__1.json',
    ]);
  });

  it('accepts a { exchanges } wrapper and a transport call log entry with a timeout result', async () => {
    const log = {
      exchanges: [
        {
          scenario: 'spike_timeout',
          operation: 'capture_order',
          request: {
            method: 'POST',
            path: '/v2/checkout/orders/5O190127TN364715T/capture',
            headers: {},
            body: '{}',
          },
          result: { kind: 'timeout' },
        },
        {
          scenario: 'spike_timeout',
          operation: 'get_order',
          request: {
            method: 'GET',
            path: '/v2/checkout/orders/5O190127TN364715T',
            headers: {},
            body: null,
          },
          result: {
            kind: 'response',
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"id":"5O190127TN364715T","status":"COMPLETED"}',
            duration_ms: 12,
          },
        },
      ],
    };
    const r = ok(await buildRecordings(log, OPTS));
    const [a, b] = r.files.map((f) => FixtureFileSchema.parse(JSON.parse(f.text)));
    expect(a?.response).toEqual({ timeout: true });
    expect(b?.response).toMatchObject({ status: 200, body: { status: 'COMPLETED' } });
  });

  it('keeps debug ids, statuses, error names and sandbox play ids by default', async () => {
    const body = {
      name: 'UNPROCESSABLE_ENTITY',
      message: 'The requested action could not be performed.',
      debug_id: 'abcdef0123456',
      details: [{ issue: 'ORDER_NOT_APPROVED' }],
      id: '5O190127TN364715T',
      status: 'CREATED',
    };
    const t = textOf(
      await buildRecordings(
        [
          exchange({
            response: { status: 422, headers: { 'PayPal-Debug-Id': 'abcdef0123456' }, body },
          }),
        ],
        OPTS,
      ),
    );
    for (const keep of [
      'UNPROCESSABLE_ENTITY',
      'abcdef0123456',
      'ORDER_NOT_APPROVED',
      '5O190127TN364715T',
      'CREATED',
      '"status": 422',
      'paypal-debug-id',
    ]) {
      expect(t, keep).toContain(keep);
    }
  });

  it('records no value in the summary, only counts and categories', async () => {
    const c = makeCanaries();
    const r = ok(await buildRecordings([hostileExchange(c)], OPTS));
    const s = formatSummary(r.summary);
    expect(s).toMatch(/1 file/);
    for (const v of c.all) expect(s).not.toContain(v);
    expect(s).not.toContain('spike');
  });
});

describe('redaction by key and by pattern', () => {
  it('removes every canary from a hostile exchange and keeps the schema valid', async () => {
    const c = makeCanaries();
    const r = ok(await buildRecordings([hostileExchange(c)], { ...OPTS, canaries: c.all }));
    const t = r.files[0]!.text;
    for (const v of c.all) expect(t.toLowerCase(), v.slice(0, 6)).not.toContain(v.toLowerCase());
    FixtureFileSchema.parse(JSON.parse(t));
    const fx = JSON.parse(t) as {
      request: { headers: Record<string, string> };
      response: { body: Record<string, unknown>; headers: Record<string, string> };
    };
    // only allow-listed request headers survive; authorization is a placeholder
    expect(fx.request.headers.authorization).toBe('[redacted]');
    expect(Object.keys(fx.request.headers).sort()).toEqual([
      'authorization',
      'content-type',
      'paypal-request-id',
    ]);
    expect(fx.response.headers['paypal-debug-id']).toBe('a1b2c3d4e5f67');
    expect(fx.response.body.debug_id).toBe('a1b2c3d4e5f67');
    expect(fx.response.body.status).toBe('APPROVED');
  });

  it('redacts payer name, address, phone, payer id and email under any key casing', async () => {
    const c = makeCanaries();
    const t = textOf(await buildRecordings([hostileExchange(c)], OPTS));
    for (const v of [c.given, c.surname, c.street, c.payerId, '4915112345678', 'Berlin']) {
      expect(t, v).not.toContain(v);
    }
  });

  it('redacts an email buried in nested JSON strings, encodings and spacing tricks', async () => {
    const c = makeCanaries();
    const t = textOf(await buildRecordings([hostileExchange(c)], OPTS)).toLowerCase();
    const local = c.email.split('@')[0]!.toLowerCase();
    const local2 = c.email2.split('@')[0]!.toLowerCase();
    expect(t).not.toContain(local);
    expect(t).not.toContain(local2);
    expect(t).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/);
    expect(t).not.toContain('%40');
    expect(t).not.toContain('&#64');
  });

  it('redacts JWT-like and long base64 values under harmless keys and inside prose', async () => {
    const c = makeCanaries();
    const t = textOf(await buildRecordings([hostileExchange(c)], OPTS));
    expect(t).not.toContain(c.jwt.split('.')[0]);
    expect(t).not.toContain(c.token.slice(10, 40));
    expect(t).not.toContain(c.basic.slice(0, 30));
    expect(t).not.toMatch(/[A-Za-z0-9+_-]{40,}/);
  });

  it('strips the query from certificate urls and keeps only the order-id token on sandbox links', async () => {
    const c = makeCanaries();
    const t = textOf(await buildRecordings([hostileExchange(c)], OPTS));
    expect(t).toContain('/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270');
    expect(t).not.toContain(c.sig);
    expect(t).not.toContain(c.plain);
    expect(t).toContain('checkoutnow?token=5O190127TN364715T');
  });

  it('treats header names case-insensitively, trims them, and drops unknown headers', async () => {
    const c = makeCanaries();
    const t = textOf(await buildRecordings([hostileExchange(c)], OPTS));
    for (const name of [
      'assertion',
      'cookie',
      'proxy-authorization',
      'x-api-key',
      'x-forwarded-email',
    ]) {
      expect(t.toLowerCase(), name).not.toContain(name);
    }
    expect((t.match(/"authorization"/g) ?? []).length).toBe(1);
  });

  it('FIX-BPREP L2: a Unicode-domain email, a relative link with a query token, a display name, a phone in prose and a free-text note do not survive', async () => {
    const c = makeCanaries();
    const t = textOf(await buildRecordings([hostileExchange(c)], OPTS));
    for (const [name, v] of Object.entries({
      uniEmail: c.uniEmail,
      uniLocal: c.uniEmail.split('@')[0]!,
      relToken: c.relToken,
      displayName: c.displayName,
      phone: c.phoneText.replace(/\s/g, ''),
      phoneSpaced: c.phoneText,
      note: c.noteText,
    }))
      expect(t.toLowerCase(), name).not.toContain(v.toLowerCase());
    expect(t).not.toMatch(/@\S*\.[a-z]{2,}/i);
  });

  it('FIX-BPREP L2: the residue check itself refuses a Unicode-domain email and a relative token link', () => {
    const wrap = (memo: string) =>
      JSON.stringify({ meta: { source: 'sandbox-recording' }, response: { body: { memo } } });
    expect(residueRule(wrap('jo@ex\u00e4mple.de'), [])).toBe('email');
    expect(residueRule(wrap('jo\uFF20ex\u00e4mple.de'), [])).toBe('email');
  });

  it('lists redaction categories in meta.redactions without values', async () => {
    const c = makeCanaries();
    const r = ok(await buildRecordings([hostileExchange(c)], OPTS));
    const fx = JSON.parse(r.files[0]!.text) as { meta: { redactions: string[] } };
    expect(fx.meta.redactions.length).toBeGreaterThan(5);
    const joined = fx.meta.redactions.join('|');
    for (const v of c.all) expect(joined).not.toContain(v);
    expect(joined).toMatch(/email/);
    expect(joined).toMatch(/header/);
  });
});

describe('synthetic ids only on request', () => {
  const ex = () =>
    exchange({
      response: {
        status: 201,
        headers: {},
        body: {
          id: '5O190127TN364715T',
          status: 'COMPLETED',
          purchase_units: [
            { payments: { captures: [{ id: '3C679366HH908993F', status: 'COMPLETED' }] } },
          ],
          links: [{ href: '/v2/checkout/orders/5O190127TN364715T', rel: 'self' }],
        },
      },
    });
  it('keeps order and capture ids by default', async () => {
    const t = textOf(await buildRecordings([ex()], OPTS));
    expect(t).toContain('5O190127TN364715T');
    expect(t).toContain('3C679366HH908993F');
  });
  it('replaces them consistently, including path pins and links, with the flag', async () => {
    const r = ok(await buildRecordings([ex(), ex()], { ...OPTS, synthetic_ids: true }));
    const t = r.files.map((f) => f.text).join('\n');
    expect(t).not.toContain('5O190127TN364715T');
    expect(t).not.toContain('3C679366HH908993F');
    expect(t).toMatch(/SBXSPIKEHAPPYORD00001/);
    expect(t).toMatch(/SBXSPIKEHAPPYCAP00001/);
    const fx = JSON.parse(r.files[0]!.text) as { meta: { expected_id: string } };
    expect(fx.meta.expected_id).toBe('SBXSPIKEHAPPYORD00001');
    expect(r.summary.ids_replaced).toBeGreaterThanOrEqual(2);
  });
});

describe('refusals', () => {
  it.each(Object.keys(liveInputs()))('refuses live or non-sandbox input: %s', async (name) => {
    const r = await buildRecordings([liveInputs()[name]], OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe('live_host');
      expect(JSON.stringify(r.refusal)).not.toContain(host.live);
      expect(JSON.stringify(r.refusal)).not.toContain(host.evil);
    }
  });

  it('accepts a sandbox api url and sandbox subdomains', async () => {
    const r = await buildRecordings(
      [
        exchange({
          request: {
            method: 'GET',
            url: `https://${host.sandboxApi}/v2/checkout/orders/5O190127TN364715T?x=1`,
            headers: {},
            body: null,
          },
        }),
      ],
      OPTS,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses when a caller canary survives (a value no rule can know)', async () => {
    const c = makeCanaries();
    const e = exchange({
      response: {
        status: 200,
        headers: {},
        body: { id: '5O190127TN364715T', status: 'CREATED', memo: c.plain },
      },
    });
    const r = await buildRecordings([e], { ...OPTS, canaries: [c.plain] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe('canary_survived');
      expect(JSON.stringify(r.refusal)).not.toContain(c.plain);
    }
  });

  it('finds a canary in encoded forms too (url-encoded, base64, case)', async () => {
    const c = makeCanaries();
    for (const form of [
      encodeURIComponent(`${c.plain} x`),
      Buffer.from(c.plain).toString('base64'),
      c.plain.toUpperCase(),
    ]) {
      const e = exchange({
        response: {
          status: 200,
          headers: {},
          body: { id: '5O190127TN364715T', memo: form.slice(0, 30) },
        },
      });
      const r = await buildRecordings([e], { ...OPTS, canaries: [c.plain] });
      expect(r.ok, form).toBe(false);
    }
  });

  it.each([
    ['scenario with a slash', { scenario: '../x' }],
    ['unknown operation', { operation: 'delete_everything' }],
    ['scenario too long', { scenario: 'a'.repeat(65) }],
  ])('refuses bad input: %s', async (_n, over) => {
    const r = await buildRecordings([exchange(over)], OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('bad_input');
  });

  it('refuses bad options: missing recorded_at, bad time, short origin, non-array input', async () => {
    for (const o of [
      { ...OPTS, recorded_at: '' },
      { ...OPTS, recorded_at: 'yesterday' },
      { ...OPTS, origin: 'x' },
    ]) {
      const r = await buildRecordings([exchange()], o);
      expect(r.ok).toBe(false);
    }
    expect((await buildRecordings({ nope: 1 }, OPTS)).ok).toBe(false);
    expect((await buildRecordings([], OPTS)).ok).toBe(false);
  });
});

describe('self test', () => {
  it('passes with canaries built at runtime and proves the checks are alive', async () => {
    const good = await recorderSelfTest();
    expect(good.ok).toBe(true);
    expect(good.failures).toEqual([]);
    expect(good.checked).toBeGreaterThan(10);
  });
});

describe('writeRecordings', () => {
  it('writes only inside fixtures/paypal/sandbox-recordings and adds a sha256 index entry', async () => {
    const root = await tmpRoot();
    const r = ok(await buildRecordings([exchange()], OPTS));
    const w = await writeRecordings(root, r.files);
    expect(w.ok).toBe(true);
    const dir = join(root, 'fixtures', 'paypal', 'sandbox-recordings');
    expect(await readdir(dir)).toEqual(['spike_happy__get_order__1.json']);
    const bytes = await readFile(join(dir, 'spike_happy__get_order__1.json'));
    const idx = JSON.parse(
      await readFile(join(root, 'fixtures', 'paypal', 'index.json'), 'utf8'),
    ) as { files: { file: string; sha256: string; source: string }[] };
    const e = idx.files.find((f) => f.file === 'sandbox-recordings/spike_happy__get_order__1.json');
    expect(e?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(e?.source).toBe('sandbox-recording');
    expect((await buildIndex(join(root, 'fixtures', 'paypal'))).files.length).toBe(1);
    expect(await readdir(join(root, 'fixtures', 'paypal'))).toEqual([
      'index.json',
      'sandbox-recordings',
      'synthetic',
    ]);
  });

  it('refuses an existing file unless overwrite is set, and writes nothing then', async () => {
    const root = await tmpRoot();
    const r = ok(await buildRecordings([exchange(), exchange({ scenario: 'other_one' })], OPTS));
    expect((await writeRecordings(root, [r.files[0]!])).ok).toBe(true);
    const again = await writeRecordings(root, r.files);
    expect(again.ok).toBe(false);
    const dir = join(root, 'fixtures', 'paypal', 'sandbox-recordings');
    expect(await readdir(dir)).toEqual(['spike_happy__get_order__1.json']);
    expect((await writeRecordings(root, r.files, { overwrite: true })).ok).toBe(true);
    expect((await readdir(dir)).length).toBe(2);
  });

  it('refuses names that could leave the folder', async () => {
    const root = await tmpRoot();
    const r = ok(await buildRecordings([exchange()], OPTS));
    for (const name of [
      '../escape__get_order__1.json',
      'a/b__get_order__1.json',
      '..\\x__get_order__1.json',
      'index.json',
      '.hidden__get_order__1.json',
    ]) {
      const w = await writeRecordings(root, [{ ...r.files[0]!, name }]);
      expect(w.ok, name).toBe(false);
    }
    expect(await readdir(join(root, 'fixtures', 'paypal'))).toEqual(['synthetic']);
  });

  it('refuses a symlinked target folder', async () => {
    const root = await tmpRoot();
    const elsewhere = await mkdtemp(join(tmpdir(), 'umsbx-elsewhere-'));
    await symlink(elsewhere, join(root, 'fixtures', 'paypal', 'sandbox-recordings'));
    const r = ok(await buildRecordings([exchange()], OPTS));
    expect((await writeRecordings(root, r.files)).ok).toBe(false);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('rolls back when the tree fails validation (duplicate key in another folder)', async () => {
    const root = await tmpRoot();
    const dup = {
      meta: {
        source: 'synthetic',
        scenario: 'spike_happy',
        operation: 'get_order',
        step: 1,
        recorded_at: null,
        origin: 'synthetic duplicate for the test',
        redactions: [],
      },
      request: {
        method: 'GET',
        path_template: '/v2/checkout/orders/{id}',
        headers: {},
        body: null,
      },
      response: { status: 200, headers: {}, body: { id: 'X' } },
    };
    await writeFile(
      join(root, 'fixtures', 'paypal', 'synthetic', 'spike_happy__get_order__1.json'),
      JSON.stringify(dup),
    );
    const r = ok(await buildRecordings([exchange()], OPTS));
    const w = await writeRecordings(root, r.files);
    expect(w.ok).toBe(false);
    expect(
      await readdir(join(root, 'fixtures', 'paypal', 'sandbox-recordings')).catch(() => []),
    ).toEqual([]);
  });

  it('does not write when the build was refused (live input)', async () => {
    const root = await tmpRoot();
    const r = await buildRecordings([liveInputs().live_url], OPTS);
    expect(r.ok).toBe(false);
    expect(await readdir(join(root, 'fixtures', 'paypal'))).toEqual(['synthetic']);
  });
});

// B-13: the recorder treats the documentation host like any other foreign host (rule A-26: the
// host is built from parts here; no literal host text in a tracked file).
describe('documentation links are dropped (B-13)', () => {
  const DOCS = ['developer', 'paypal', 'com'].join('.');
  const DOC_URL = `https://${DOCS}/docs/api/orders/v2/#error-ORDER_NOT_APPROVED`;
  const errorBody = (extra: Record<string, unknown>) => ({
    name: 'UNPROCESSABLE_ENTITY',
    message: 'The requested action could not be performed.',
    debug_id: 'a1b2c3d4e5f67',
    details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not approved.' }],
    ...extra,
  });
  const build = async (body: Record<string, unknown>) =>
    ok(
      await buildRecordings(
        [
          exchange({
            scenario: 'capture_before_approval',
            operation: 'capture_order',
            request: {
              method: 'POST',
              path: '/v2/checkout/orders/5O190127TN364715T/capture',
              headers: {},
              body: null,
            },
            response: { status: 422, headers: {}, body },
          }),
        ],
        OPTS,
      ),
    );
  const noDocsHost = (text: string) => {
    expect(text).not.toMatch(new RegExp(DOCS.replace(/\./g, '\\.'), 'i'));
    expect(decodeURIComponent(text)).not.toMatch(new RegExp(DOCS.replace(/\./g, '\\.'), 'i'));
  };

  const cases: Record<string, Record<string, unknown>> = {
    'top-level information_link': errorBody({ information_link: DOC_URL }),
    'information_link inside details': errorBody({
      details: [{ issue: 'ORDER_NOT_APPROVED', information_link: DOC_URL }],
    }),
    'links[] entry with a rel': errorBody({ links: [{ href: DOC_URL, rel: 'information_link' }] }),
    'host inside free text': errorBody({ message: `See ${DOC_URL} for the fix, then retry.` }),
    'upper case': errorBody({
      information_link: DOC_URL.replace(DOCS, DOCS.toUpperCase()).replace('https', 'HTTPS'),
    }),
    'trailing dot on the host': errorBody({ information_link: DOC_URL.replace(DOCS, `${DOCS}.`) }),
    'percent-encoded form': errorBody({ information_link: encodeURIComponent(DOC_URL) }),
    'bare host without a scheme': errorBody({ message: `docs at ${DOCS}/docs/api/orders/v2/` }),
  };

  it.each(Object.keys(cases))('replaces the link and counts a foreign url: %s', async (name) => {
    const r = await build(cases[name]!);
    const text = r.files.map((f) => f.text).join('\n');
    noDocsHost(text);
    expect(text).toContain('[redacted-url]');
    expect(r.summary.redactions['foreign url'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(text).toContain('ORDER_NOT_APPROVED');
    expect(FixtureFileSchema.safeParse(JSON.parse(r.files[0]!.text)).success).toBe(true);
  });

  it('keeps sandbox hosts and relative /v2 links exactly as before', async () => {
    const r = await build(
      errorBody({
        links: [
          {
            href: `https://${host.sandboxWww}/checkoutnow?token=5O190127TN364715T`,
            rel: 'approve',
          },
          { href: '/v2/checkout/orders/5O190127TN364715T', rel: 'self' },
          { href: DOC_URL, rel: 'information_link' },
        ],
      }),
    );
    const text = r.files.map((f) => f.text).join('\n');
    expect(text).toContain(`https://${host.sandboxWww}/checkoutnow?token=5O190127TN364715T`);
    expect(text).toContain('/v2/checkout/orders/5O190127TN364715T');
    noDocsHost(text);
    expect(r.summary.redactions['foreign url']).toBe(1);
  });

  it('the output check refuses a result that still holds the documentation host', () => {
    const wrap = (value: string) =>
      JSON.stringify({ meta: { source: 'sandbox-recording' }, response: { body: { x: value } } });
    for (const v of [
      DOC_URL,
      DOC_URL.replace(DOCS, DOCS.toUpperCase()),
      DOC_URL.replace(DOCS, `${DOCS}.`),
      encodeURIComponent(DOC_URL),
      `${DOCS}/docs`,
    ]) {
      expect(residueRule(wrap(v), []), v).not.toBeNull();
    }
    expect(residueRule(wrap(`https://${host.sandboxWww}/checkoutnow`), [])).toBeNull();
  });
});
