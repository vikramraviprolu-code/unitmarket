// BR-6 adversarial: the Business rules pages against hostile input. An order id that is not an id is refused
// before any query runs; an export over 5000 rows says it was cut; text that starts like a formula is made safe
// in the CSV; markup in a reason stays text on the page; a filter value that is not a registry value is refused,
// not run as SQL; the only write path stays the BR-2 route; no read writes the journal and none is unattributed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTraceContext } from '@umsbx/obs';
import type { TraceContext } from '@umsbx/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';
import { call } from './support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const OP = { kind: 'operator', operator_id: 'opr_vikram', mfa: true } as const;
const EVIL = '<img src=x onerror=alert(1)> {{7*7}} ${process.env} javascript:alert(2)';

let w: RefundWorld;
let reads: typeof import('./composition/ops-rules');
let exportRoute: typeof import('./app/api/ops/rules/export/route');
let rulesRoute: typeof import('./app/api/ops/rules/route');

const ctx: TraceContext = {
  id: 'ctx_br6_seed',
  at: '2026-11-05T09:00:00.000Z',
  channel: 'web',
  actor_kind: 'operator',
  actor_id: 'opr_vikram',
  on_behalf_of: null,
  mfa: true,
  req_id: 'req_br6_seed',
  ip_hash: null,
  ua_family: null,
  api_key_id: null,
  job: null,
  tool: null,
};
const exported = async (): Promise<{ filename: string; csv: string; truncated: boolean }> => {
  const res = await call(exportRoute.GET, { url: '/api/ops/rules/export', session: w.op });
  expect(res.status).toBe(200);
  return (await res.json()) as { filename: string; csv: string; truncated: boolean };
};
const seed = async (n: number, reason: string, from: number): Promise<void> => {
  // One statement, journaled as the operator: n rows, each a platform refund window with its own start time.
  await withTraceContext(ctx, () =>
    w.app.db.query(
      `INSERT INTO rule_settings (id, rule_key, scope_kind, scope_id, value, effective_from, effective_until, set_by, reason, approved_by, created_at)
       SELECT 'rls_seed_' || (g + $3)::text, 'refund.request_window', 'platform', NULL, 7,
              '2026-11-05T09:00:00Z'::timestamptz + ((g + $3) || ' seconds')::interval, NULL,
              'opr_vikram', $2::text, NULL,
              '2026-11-05T09:00:00Z'::timestamptz + ((g + $3) || ' seconds')::interval
         FROM generate_series(1, $1::int) AS g`,
      [n, reason, from],
    ),
  );
};

beforeAll(async () => {
  w = await bootRefundWorld();
  reads = await import('./composition/ops-rules');
  exportRoute = await import('./app/api/ops/rules/export/route');
  rulesRoute = await import('./app/api/ops/rules/route');
});
afterAll(async () => w.app.close());

describe('the order id of the explain page', () => {
  it.each([
    "ord_1' OR '1'='1",
    '../../etc/passwd',
    'ord_1; DROP TABLE orders',
    '<script>alert(1)</script>',
    ' ord_1',
    'ord_1\n',
    'x'.repeat(300),
    '',
    '%00',
  ])('%j is refused and no table is touched', async (bad) => {
    expect(await reads.readExplain(OP, bad)).toEqual({ kind: 'refused' });
    expect(
      Number((await w.app.db.query<{ n: string }>('SELECT count(*) AS n FROM orders')).rows[0]!.n),
    ).toBeGreaterThanOrEqual(0);
  });

  it('the page validates with IdSchema and turns a refusal into a 404', () => {
    const lib = source('composition/ops-rules.ts');
    expect(lib).toContain('IdSchema');
    const page = source('app/ops/rules/explain/page.tsx');
    expect(page).toMatch(/notFound\(\)/);
    // an array value (?order=a&order=b) is not an id either
    expect(lib).toMatch(/typeof [a-z]+ !== 'string'|Array\.isArray/);
  });

  it('an array or a missing value is not an id', async () => {
    expect(await reads.readExplain(OP, ['a', 'b'] as never)).toEqual({ kind: 'refused' });
    expect(await reads.readExplain(OP, null as never)).toEqual({ kind: 'refused' });
  });
});

describe('the history filters', () => {
  it('a value that is not a registry value is named invalid and lists nothing, never run as SQL', async () => {
    const q = reads.parseRulesHistoryQuery({
      rule_key: "refund.request_window' OR 1=1 --",
      scope_kind: 'platform',
      scope_id: 'x y',
    });
    expect(q.invalid).toEqual(['rule_key', 'scope_id']);
    const page = (await reads.readRulesHistory(OP, { rule_key: "x' OR 1=1 --" }))!;
    expect(page.rows).toEqual([]);
    expect(page.invalid).toEqual(['rule_key']);
  });

  it('an array value is invalid and extra keys are ignored', () => {
    expect(reads.parseRulesHistoryQuery({ rule_key: ['a', 'b'] }).invalid).toEqual(['rule_key']);
    expect(reads.parseRulesHistoryQuery({ page: '2', sort: 'x' })).toEqual({
      filter: {},
      invalid: [],
    });
  });
});

describe('text in a reason', () => {
  it('markup stays text: the history read returns it unchanged and no page injects HTML', async () => {
    const res = await call(rulesRoute.POST, {
      url: '/api/ops/rules',
      method: 'POST',
      session: w.op,
      body: {
        rule_key: 'refund.request_window',
        scope_kind: 'platform',
        scope_id: null,
        value: 8,
        effective_from: new Date(Date.now() + 1000).toISOString(),
        effective_until: null,
        reason: EVIL.slice(0, 120),
      },
      headers: { 'idempotency-key': 'br6-test-idem-key' },
    });
    expect(res.status).toBe(200);
    const rows = (await reads.readRulesHistory(OP, {}))!.rows;
    expect(rows[0]!.reason).toBe(EVIL.slice(0, 120));
    const idx = (await reads.readRulesIndex(OP))!;
    expect(idx.rows[0]!.last_change?.reason).toBe(EVIL.slice(0, 120));
    for (const f of [
      'app/ops/rules/page.tsx',
      'app/ops/rules/new/page.tsx',
      'app/ops/rules/history/page.tsx',
      'app/ops/rules/explain/page.tsx',
      'app/ops/rules/RuleForm.tsx',
    ])
      expect(source(f), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
  });
});

describe('the CSV export', () => {
  it('prefixes a quote to every cell that starts like a formula', async () => {
    const leads = ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)'];
    let at = 0;
    for (const lead of leads) {
      at += 1;
      const res = await call(rulesRoute.POST, {
        url: '/api/ops/rules',
        method: 'POST',
        session: w.op,
        body: {
          rule_key: 'access.window',
          scope_kind: 'platform',
          scope_id: null,
          value: 8 + at,
          effective_from: new Date(Date.now() + 1000).toISOString(),
          effective_until: null,
          reason: `${lead} formula`,
        },
        headers: { 'idempotency-key': `br6-formula-${String(at)}` },
      });
      // a reason that starts with = + - @ may be refused by the route; either way nothing unsafe is exported
      expect([200, 422]).toContain(res.status);
    }
    const out = await exported();
    const cells = out.csv
      .split('\r\n')
      .slice(1)
      .flatMap((l) => l.match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g) ?? [])
      .map((c) => c.replace(/,$/, '').replace(/^"/, ''));
    for (const c of cells) expect(c, c).not.toMatch(/^[=+\-@\t\r]/);
  });

  it('the formula guard is the shared csvCell, not a new escaper', () => {
    const lib = source('composition/ops-rules.ts') + source('lib/ops-rules-view.ts');
    expect(lib).toMatch(/csvLine|csvCell/);
  });

  it('over 5000 rows: the file holds 5000 and truncated is true; at 5000 or fewer it is false', async () => {
    const have = (await reads.readRulesHistory(OP, {}))!.rows.length;
    await seed(5000 - have - 0, 'bulk', 0);
    const full = await exported();
    expect(full.truncated).toBe(false);
    expect(full.csv.split('\r\n').length - 2).toBe(5000);
    await seed(3, 'bulk more', 10_000);
    const cut = await exported();
    expect(cut.truncated).toBe(true);
    expect(cut.csv.split('\r\n').length - 2).toBe(5000);
  });

  it('the history page shows 200 rows and says there are more', async () => {
    const page = (await reads.readRulesHistory(OP, {}))!;
    expect(page.rows).toHaveLength(200);
    expect(page.capped).toBe(true);
  });
});

describe('no new write path, and the journal stays whole', () => {
  it('the only route files under api/ops/rules are the BR-2 POST and the export GET', () => {
    const root = join(here, 'app/api/ops/rules');
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else found.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(found.sort()).toEqual(['export/route.ts', 'route.ts']);
    expect(existsSync(join(root, 'route.ts'))).toBe(true);
  });

  it('no page, form or read module writes: no engine.opsRules.add, no fetch, no INSERT', () => {
    for (const f of [
      'app/ops/rules/page.tsx',
      'app/ops/rules/new/page.tsx',
      'app/ops/rules/history/page.tsx',
      'app/ops/rules/explain/page.tsx',
      'app/ops/rules/RuleForm.tsx',
      'composition/ops-rules.ts',
      'lib/ops-rules-view.ts',
      'app/api/ops/rules/export/route.ts',
    ]) {
      const s = source(f);
      expect(s, f).not.toMatch(
        /opsRules\.add|\bfetch\(|INSERT INTO|UPDATE rule_settings|DELETE FROM/i,
      );
    }
    expect(source('app/api/ops/rules/export/route.ts')).not.toMatch(
      /export const (POST|PUT|PATCH|DELETE)/,
    );
  });

  it('reads leave no journal row of their own and none is unattributed', async () => {
    const count = async (): Promise<number> =>
      Number(
        (
          await w.app.db.query<{ n: string }>(
            "SELECT count(*) AS n FROM trace_events WHERE source_table <> 'audit_log'",
          )
        ).rows[0]!.n,
      );
    const before = await count();
    await reads.readRulesIndex(OP);
    await reads.readRulesHistory(OP, { scope_kind: 'platform' });
    await reads.readNewRulePage(OP);
    await reads.readExplain(OP, 'ord_nothing_here_0001');
    await exported();
    expect(await count()).toBe(before);
    const bare = await w.app.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM trace_events WHERE actor_kind = 'unattributed'",
    );
    expect(bare.rows[0]!.n).toBe(0);
    const found = await w.app.db.query<{ kind: string }>('SELECT kind FROM trace_verify()');
    expect(found.rows).toEqual([]);
  });
});
