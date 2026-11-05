// BR-6: the operator "Business rules" screens. The pages are thin: each checks the sign-in and shows what a
// composition read (composition/ops-rules.ts) returns, so the tests drive the reads on the real app, read the
// page files as text (the vitest runner does not compile .tsx), and post through the BR-2 route, the only write
// path. Covers: each page and read works for an operator and refuses a buyer, a seller and a visitor; the index
// row per registry key; the history filters; the new rule form (impact line, posts with the second factor and an
// Idempotency-Key); the explain page (value and source per key, an old order); the export JSON shape.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '@umsbx/security';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { call } from './support';
import type { Session } from './support';
import { OLD_ORDER_LINE, impactLine } from './lib/ops-rules-copy';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGES = [
  'app/ops/rules/page.tsx',
  'app/ops/rules/new/page.tsx',
  'app/ops/rules/history/page.tsx',
  'app/ops/rules/explain/page.tsx',
];

const OP = { kind: 'operator', operator_id: 'opr_vikram', mfa: true } as const;
const PLAIN = { kind: 'operator', operator_id: 'opr_demo', mfa: false } as const;

let w: RefundWorld;
let reads: typeof import('./composition/ops-rules');
let exportRoute: typeof import('./app/api/ops/rules/export/route');
let rulesRoute: typeof import('./app/api/ops/rules/route');
let seller: string;
let buyer: string;
let publisher: Session;
let unit: BoughtUnit;
let v1Unit: BoughtUnit;
let orderId = '';
let v1OrderId = '';

// The test has no clock to read (S6); the database's is the one the form and the index use too.
const when = async (offsetMs: number): Promise<string> => {
  const r = await w.app.db.query<{ t: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`,
  );
  return new Date(Date.parse(r.rows[0]!.t) + offsetMs).toISOString();
};
const post = (s: Session | null, body: unknown, key: string): Promise<Response> =>
  call(rulesRoute.POST, {
    url: '/api/ops/rules',
    method: 'POST',
    session: s,
    body,
    headers: { 'idempotency-key': key },
  });

beforeAll(async () => {
  w = await bootRefundWorld();
  reads = await import('./composition/ops-rules');
  exportRoute = await import('./app/api/ops/rules/export/route');
  rulesRoute = await import('./app/api/ops/rules/route');
  // The publisher of the offers the world sells, so the seller setting applies to the sales below.
  seller = (
    await w.app.db.query<{ id: string }>("SELECT id FROM publishers WHERE slug = 'harbour-ledger'")
  ).rows[0]!.id;
  buyer = (
    await w.app.db.query<{ id: string }>(
      "SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'",
    )
  ).rows[0]!.id;
  publisher = await (async () => {
    const s = await createSession(w.app.security, { kind: 'publisher', publisher_id: seller });
    return { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
  })();
  // A seller override that is live before the sale, so the sale's terms name it as their source.
  const added = await post(
    w.op,
    {
      rule_key: 'refund.request_window',
      scope_kind: 'seller',
      scope_id: seller,
      value: 14,
      effective_from: await when(0),
      effective_until: null,
      reason: 'Longer window for this seller',
    },
    'br6-seed-seller',
  );
  expect(added.status).toBe(200);
  unit = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
  orderId = unit.order_id;
  v1Unit = await buy(w, { offer: 'knot-notebook', option: 'online_read', who: 'B' });
  v1OrderId = v1Unit.order_id;
  // Rewrite one stored approval to its version 1 shape (an order approved before BR-3). The guard trigger
  // refuses an UPDATE of the snapshot, so it is switched off for this one statement and back on.
  await w.app.db.query('ALTER TABLE approvals DISABLE TRIGGER approvals_guard');
  await w.app.db.query(
    `UPDATE approvals SET snapshot = (snapshot - 'terms') || '{"snapshot_version":"1"}'::jsonb
      WHERE id = (SELECT approval_id FROM orders WHERE id = $1)`,
    [v1OrderId],
  );
  await w.app.db.query('ALTER TABLE approvals ENABLE TRIGGER approvals_guard');
});
afterAll(async () => w.app.close());

describe('the files are where the spec puts them', () => {
  it.each([
    ...PAGES,
    'app/ops/rules/RuleForm.tsx',
    'app/api/ops/rules/export/route.ts',
    'composition/ops-rules.ts',
    'lib/ops-rules-copy.ts',
    'lib/ops-rules-view.ts',
  ])('%s exists', (f) => {
    expect(existsSync(join(here, f)), f).toBe(true);
  });
});

describe('who may open a page', () => {
  it.each(PAGES)(
    '%s sends a buyer, a seller and a visitor to sign in before it reads anything',
    (f) => {
      const page = read(f);
      expect(page).toMatch(/actor\?\.kind !== 'operator'\) redirect\(/);
      expect(page.indexOf("actor?.kind !== 'operator'")).toBeLessThan(
        page.search(/await read[A-Z]/),
      );
    },
  );

  it('every read answers null for a buyer, a seller and the system', async () => {
    for (const actor of [
      w.actorA,
      w.actorB,
      { kind: 'publisher', publisher_id: seller },
      { kind: 'system' },
    ] as const) {
      expect(await reads.readRulesIndex(actor as never), 'index').toBeNull();
      expect(await reads.readNewRulePage(actor as never), 'new').toBeNull();
      expect(await reads.readRulesHistory(actor as never, {}), 'history').toBeNull();
      expect(await reads.readExplain(actor as never, orderId), 'explain').toBeNull();
      expect(await reads.readRulesExport(actor as never), 'export').toBeNull();
    }
  });

  it('the export route refuses a buyer, a seller and a visitor and answers an operator', async () => {
    for (const s of [w.A, publisher, null]) {
      const res = await call(exportRoute.GET, { url: '/api/ops/rules/export', session: s });
      expect([401, 403], String(s === null ? 'visitor' : 'session')).toContain(res.status);
    }
    const ok = await call(exportRoute.GET, { url: '/api/ops/rules/export', session: w.op });
    expect(ok.status).toBe(200);
  });

  it('the export route is declared as the spec says', () => {
    expect(exportRoute.routeMeta).toMatchObject({
      path: '/api/ops/rules/export',
      method: 'GET',
      auth: 'operator',
      csrf: false,
      idempotent: false,
    });
    expect(Object.keys(exportRoute)).not.toContain('POST');
  });
});

describe('the index: one row per registry key', () => {
  it('has the three slice keys with range, scopes, overrides and the platform value', async () => {
    const r = (await reads.readRulesIndex(OP))!;
    expect(r.rows.map((x) => x.key)).toEqual([
      'refund.request_window',
      'access.window',
      'mandate.max_days',
    ]);
    const refund = r.rows[0]!;
    expect(refund).toMatchObject({
      label: 'Refund window',
      unit: 'days',
      min: 0,
      max: 30,
      platform_value: 7,
      platform_source: 'default',
      seller_overrides: 1,
      buyer_overrides: 0,
    });
    expect(refund.scopes).toEqual(['platform', 'category', 'seller', 'buyer']);
    expect(refund.last_change).toMatchObject({
      reason: 'Longer window for this seller',
      by: 'opr_vikram',
    });
    expect(r.rows[1]).toMatchObject({ platform_value: 5, seller_overrides: 0, last_change: null });
    expect(r.rows[2]).toMatchObject({ platform_value: 90, scopes: ['platform', 'buyer'] });
    expect(['dryrun', 'sandbox']).toContain(r.environment);
  });

  it('a platform change shows as the platform value and counts a buyer override', async () => {
    expect(
      (
        await post(
          w.op,
          {
            rule_key: 'refund.request_window',
            scope_kind: 'platform',
            scope_id: null,
            value: 10,
            effective_from: await when(0),
            effective_until: null,
            reason: 'Pilot window',
          },
          'br6-platform-10',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          w.op,
          {
            rule_key: 'refund.request_window',
            scope_kind: 'buyer',
            scope_id: buyer,
            value: 3,
            effective_from: await when(0),
            effective_until: null,
            reason: 'Buyer asked for less',
          },
          'br6-buyer-3',
        )
      ).status,
    ).toBe(200);
    const refund = (await reads.readRulesIndex(OP))!.rows[0]!;
    expect(refund).toMatchObject({
      platform_value: 10,
      platform_source: 'setting',
      seller_overrides: 1,
      buyer_overrides: 1,
    });
    expect(refund.last_change).toMatchObject({ reason: 'Buyer asked for less' });
  });

  it('an operator without the authenticator code sees the change but not who made it', async () => {
    const refund = (await reads.readRulesIndex(PLAIN))!.rows[0]!;
    expect(refund.last_change?.reason).toBe('Buyer asked for less');
    expect(refund.last_change?.by).toBeNull();
    expect(JSON.stringify(await reads.readRulesIndex(PLAIN))).not.toContain('opr_vikram');
  });
});

describe('the history', () => {
  it('lists newest first and filters by key, scope and operator', async () => {
    const all = (await reads.readRulesHistory(OP, {}))!;
    expect(all.rows.map((x) => x.reason)).toEqual([
      'Buyer asked for less',
      'Pilot window',
      'Longer window for this seller',
    ]);
    expect(all.capped).toBe(false);
    const byKey = (await reads.readRulesHistory(OP, { rule_key: 'access.window' }))!;
    expect(byKey.rows).toEqual([]);
    const byScope = (await reads.readRulesHistory(OP, { scope_kind: 'seller' }))!;
    expect(byScope.rows.map((x) => x.reason)).toEqual(['Longer window for this seller']);
    const byOperator = (await reads.readRulesHistory(OP, { operator: 'opr_vikram' }))!;
    expect(byOperator.rows).toHaveLength(3);
    const noMatch = (await reads.readRulesHistory(OP, { operator: 'opr_nobody' }))!;
    expect(noMatch.rows).toEqual([]);
  });

  it('the operator filter needs the second factor and the rows hold no identity without it', async () => {
    const plain = (await reads.readRulesHistory(PLAIN, { operator: 'opr_vikram' }))!;
    // the filter is ignored for a session without the code: all rows, none naming an operator
    expect(plain.rows).toHaveLength(3);
    expect(JSON.stringify(plain)).not.toContain('opr_vikram');
    expect(plain.mfa).toBe(false);
  });

  it('parses a query string: known values pass, the rest are named as invalid', () => {
    expect(
      reads.parseRulesHistoryQuery({ rule_key: 'access.window', scope_kind: 'buyer' }),
    ).toEqual({
      filter: { rule_key: 'access.window', scope_kind: 'buyer' },
      invalid: [],
    });
    const bad = reads.parseRulesHistoryQuery({ rule_key: 'fee.rate', scope_kind: 'offer' });
    expect(bad.invalid).toEqual(['rule_key', 'scope_kind']);
    expect(bad.filter).toEqual({});
  });
});

describe('the new rule page and form', () => {
  it('the read gives the keys with ranges, the scopes, a start time and a single-use key', async () => {
    const p = (await reads.readNewRulePage(OP))!;
    expect(p.rules.map((x) => x.key)).toEqual([
      'refund.request_window',
      'access.window',
      'mandate.max_days',
    ]);
    expect(p.rules[0]).toMatchObject({ label: 'Refund window', min: 0, max: 30, unit: 'days' });
    expect(p.rules[0]!.scopes).toEqual([
      { kind: 'platform', label: 'Everyone' },
      { kind: 'category', label: 'A category' },
      { kind: 'seller', label: 'One seller' },
      { kind: 'buyer', label: 'One buyer' },
    ]);
    expect(p.default_from).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(p.mfa).toBe(true);
    const second = (await reads.readNewRulePage(OP))!;
    expect(second.key).not.toBe(p.key);
    expect(p.key.length).toBeGreaterThanOrEqual(16);
  });

  it('shows the impact line before submit, and the words are the golden ones', () => {
    expect(impactLine('2026-11-05T12:00:00.000Z')).toBe(
      'Applies to new sales from 2026-11-05 12:00 UTC. Sales already approved keep their terms.',
    );
    const form = read('app/ops/rules/RuleForm.tsx');
    expect(form).toContain('impactLine(');
    expect(form).toMatch(/role="status"|aria-live=/);
  });

  it('posts only to the BR-2 route, through client-api, with an Idempotency-Key', () => {
    const form = read('app/ops/rules/RuleForm.tsx');
    expect(form).toContain("from '../../../lib/client-api'");
    expect(form).toContain("'/api/ops/rules'");
    expect(form).toMatch(/'idempotency-key'/);
    expect(form).not.toMatch(/\bfetch\(/);
    for (const field of [
      'rule_key',
      'scope_kind',
      'scope_id',
      'value',
      'effective_from',
      'effective_until',
      'reason',
    ])
      expect(form, field).toContain(field);
    // every input carries a label
    expect((form.match(/<label\b/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(form).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('a session with the code posts the key the page gave and the row appears in the index and history', async () => {
    const page = (await reads.readNewRulePage(OP))!;
    const res = await post(
      w.op,
      {
        rule_key: 'access.window',
        scope_kind: 'platform',
        scope_id: null,
        value: 12,
        effective_from: page.default_from,
        effective_until: null,
        reason: 'Access follows the refund window',
      },
      page.key,
    );
    expect(res.status).toBe(200);
    const index = (await reads.readRulesIndex(OP))!;
    expect(index.rows[1]).toMatchObject({ platform_value: 12, platform_source: 'setting' });
    const hist = (await reads.readRulesHistory(OP, { rule_key: 'access.window' }))!;
    expect(hist.rows.map((x) => x.value)).toEqual([12]);
  });

  it('a session without the code gets reader-safe words and nothing is written', async () => {
    const before = (await reads.readRulesHistory(OP, {}))!.rows.length;
    const res = await post(
      w.demo,
      {
        rule_key: 'refund.request_window',
        scope_kind: 'platform',
        scope_id: null,
        value: 20,
        effective_from: await when(0),
        effective_until: null,
        reason: 'No code used',
      },
      'br6-no-code',
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('mfa_required');
    expect(body.error.message).toMatch(/second factor|authenticator code/);
    expect((await reads.readRulesHistory(OP, {}))!.rows.length).toBe(before);
  });

  it('tells a session without the code, before it types anything, that the change needs it', async () => {
    expect((await reads.readNewRulePage(PLAIN))!.mfa).toBe(false);
    expect(read('app/ops/rules/new/page.tsx')).toMatch(/mfa/);
  });
});

describe('the explain page', () => {
  it('shows value and source for each key, the rules version and the digest', async () => {
    const r = (await reads.readExplain(OP, orderId))!;
    expect(r.kind).toBe('terms');
    if (r.kind !== 'terms') return;
    expect(r.order_id).toBe(orderId);
    expect(r.rules_version).toBe('1');
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.rows.map((x) => x.key)).toEqual([
      'refund.request_window',
      'access.window',
      'mandate.max_days',
    ]);
    const refund = r.rows[0]!;
    // the seller override that was live when the sale was approved
    expect(refund.value).toBe(14);
    expect(refund.unit).toBe('days');
    expect(refund.source).toMatch(/^Seller setting/);
    expect(refund.source).toContain(seller);
    // not the platform value that was set later
    expect(r.rows[2]).toMatchObject({ value: 90, source: 'Platform default' });
  });

  it('finds the same order by the order reference the operator pages show', async () => {
    const byRef = (await reads.readExplain(OP, unit.order_ref))!;
    const byId = (await reads.readExplain(OP, orderId))!;
    expect(byRef).toEqual(byId);
    expect(byRef.kind).toBe('terms');
  });

  it('a version 1 order says it was approved before terms were recorded', async () => {
    const r = (await reads.readExplain(OP, v1OrderId))!;
    expect(r).toEqual({ kind: 'old', order_id: v1OrderId, line: OLD_ORDER_LINE });
    expect(OLD_ORDER_LINE).toBe('Approved before terms were recorded');
  });

  it('no order given is a blank page, an unknown order is refused', async () => {
    expect(await reads.readExplain(OP, undefined)).toEqual({ kind: 'blank' });
    expect(await reads.readExplain(OP, 'ord_does_not_exist_0001')).toEqual({ kind: 'refused' });
  });

  it('the page turns a refused id into a 404 and an explain read changes nothing', async () => {
    const page = read('app/ops/rules/explain/page.tsx');
    expect(page).toMatch(/notFound\(\)/);
    const before = Number(
      (await w.app.db.query<{ n: string }>('SELECT count(*) AS n FROM trace_events')).rows[0]!.n,
    );
    await reads.readExplain(OP, orderId);
    await reads.readRulesIndex(OP);
    await reads.readRulesHistory(OP, {});
    const after = Number(
      (await w.app.db.query<{ n: string }>('SELECT count(*) AS n FROM trace_events')).rows[0]!.n,
    );
    expect(after).toBe(before);
  });
});

describe('the export', () => {
  it('answers { filename, csv, truncated } with a header and one line per setting', async () => {
    const res = await call(exportRoute.GET, { url: '/api/ops/rules/export', session: w.op });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { filename: string; csv: string; truncated: boolean };
    expect(Object.keys(out).sort()).toEqual(['csv', 'filename', 'truncated']);
    expect(out.filename).toBe('business-rules-history.csv');
    expect(out.truncated).toBe(false);
    const lines = out.csv.split('\r\n');
    expect(lines[0]).toBe(
      'rule_key,scope_kind,scope_id,value,effective_from,effective_until,set_by,reason,created_at',
    );
    expect(lines.length - 2).toBe((await reads.readRulesHistory(OP, {}))!.rows.length);
    expect(lines.at(-1)).toBe('');
  });
});
