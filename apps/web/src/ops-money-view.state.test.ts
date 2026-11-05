// INT-OPS-C / OPS-C.4: the Money tab totals per environment, currency and kind, each opening a ledger list at
// /ops/money/ledger?environment=&currency=&kind=; the reconciler state; today's exchange rates. Every total is the
// sum of its list; dryrun and sandbox rows never share a total and each carries its stored environment (C6).
// Without the second factor a ledger line shows capture_id and refund_id as the last four only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld, buy, postRefund } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { ledgerHref, parseLedgerQuery } from './lib/ops-money-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };

let w: RefundWorld;
let money: typeof import('./composition/ops-money');
const units: BoughtUnit[] = [];
let sandboxCapture = '';

beforeAll(async () => {
  w = await bootRefundWorld();
  money = await import('./composition/ops-money');
  units.push(await buy(w, { offer: 'knot-notebook', option: 'online_read' }));
  units.push(await buy(w, { offer: 'harbour-fees', option: 'online_read' }));
  units.push(await buy(w, { offer: 'tide-tables', option: 'online_read', who: 'B' }));
  const r = await postRefund(w, w.op, {
    unit_id: units[0]!.unit_id,
    amount_minor: null,
    reason: 'Customer asked for a refund',
  });
  if (r.status !== 200) throw new Error(`refund ${r.status}`);
  // One row recorded as sandbox, on a real captured unit, so the two environments must not share a total.
  const u = (
    await w.app.db.query<{ id: string; capture_id: string }>(
      'SELECT id, capture_id FROM order_units WHERE id = $1',
      [units[2]!.unit_id],
    )
  ).rows[0]!;
  sandboxCapture = u.capture_id;
  const at = w.app.security.clock.now().toISOString();
  await w.app.db.query(
    `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id, ref_entry_id, environment, created_at, updated_at)
     VALUES ('led_opsc_sbx1', $1, $2, 'platform_fee', 7, $3, NULL, NULL, 'sandbox', $4, $4)`,
    [u.id, u.capture_id, units[2]!.currency, at],
  );
});
afterAll(async () => w.app.close());

describe('the ledger query', () => {
  it('ledgerHref builds the list URL of one total', () => {
    expect(ledgerHref('dryrun', 'USD', 'sale')).toBe(
      '/ops/money/ledger?environment=dryrun&currency=USD&kind=sale',
    );
  });
  it('parseLedgerQuery accepts only a stored environment, a currency code and a ledger kind', () => {
    expect(parseLedgerQuery({ environment: 'sandbox', currency: 'EUR', kind: 'refund' })).toEqual({
      environment: 'sandbox',
      currency: 'EUR',
      kind: 'refund',
    });
    for (const bad of [
      {},
      { environment: 'live', currency: 'USD', kind: 'sale' },
      { environment: 'dryrun', currency: 'usd', kind: 'sale' },
      { environment: 'dryrun', currency: 'USD', kind: 'payout' },
      { environment: ['dryrun', 'sandbox'], currency: 'USD', kind: 'sale' },
    ])
      expect(parseLedgerQuery(bad as never)).toBeNull();
  });
});

describe('OPS-C.4 totals and the ledger list', () => {
  it('each total equals the sum of its ledger list', async () => {
    const read = await money.readMoneyTotals(MFA);
    if (read === null) throw new Error('expected a read');
    expect(read.totals.length).toBeGreaterThanOrEqual(3);
    for (const t of read.totals) {
      expect(t.href).toBe(ledgerHref(t.environment, t.currency, t.kind));
      const list = await money.readLedgerList(MFA, {
        environment: t.environment,
        currency: t.currency,
        kind: t.kind,
      });
      if (list === null) throw new Error('expected a list');
      expect(list.lines.reduce((s, l) => s + l.amount_minor, 0)).toBe(t.total_minor);
      expect(list.lines).toHaveLength(t.count);
      expect(list.total_minor).toBe(t.total_minor);
    }
  });

  it('the totals match the stored rows grouped by environment, currency and kind', async () => {
    const read = await money.readMoneyTotals(MFA);
    const db = (
      await w.app.db.query<{ environment: string; currency: string; kind: string; s: string }>(
        'SELECT environment, currency, kind, sum(amount_minor) AS s FROM ledger_entries GROUP BY 1, 2, 3 ORDER BY 1, 2, 3',
      )
    ).rows.map((r) => [r.environment, r.currency, r.kind, Number(r.s)]);
    expect(read!.totals.map((t) => [t.environment, t.currency, t.kind, t.total_minor])).toEqual(db);
  });

  it('a dryrun and a sandbox row give two separate totals, each labelled from the stored value', async () => {
    const read = await money.readMoneyTotals(MFA);
    const fees = read!.totals.filter((t) => t.kind === 'platform_fee');
    const sbx = fees.find((t) => t.environment === 'sandbox');
    expect(sbx).toMatchObject({
      environment: 'sandbox',
      label: 'Sandbox',
      total_minor: 7,
      count: 1,
    });
    const sales = read!.totals.filter((t) => t.kind === 'sale');
    expect(sales.every((t) => t.environment === 'dryrun' && t.label === 'Dry run')).toBe(true);
    const list = await money.readLedgerList(MFA, {
      environment: 'sandbox',
      currency: units[2]!.currency,
      kind: 'platform_fee',
    });
    expect(list!.lines.map((l) => l.id)).toEqual(['led_opsc_sbx1']);
    expect(list!.label).toBe('Sandbox');
  });

  it('without the second factor a ledger line shows capture_id and refund_id as the last four only', async () => {
    const stored = (
      await w.app.db.query<{ capture_id: string; refund_id: string | null }>(
        "SELECT capture_id, refund_id FROM ledger_entries WHERE kind = 'refund'",
      )
    ).rows;
    expect(stored.length).toBeGreaterThanOrEqual(1);
    const q = { environment: 'dryrun', currency: units[0]!.currency, kind: 'refund' };
    const plain = await money.readLedgerList(PLAIN, q);
    const json = JSON.stringify(plain);
    for (const s of stored) {
      expect(json).not.toContain(s.capture_id);
      expect(json).toContain(`…${s.capture_id.slice(-4)}`);
      if (s.refund_id !== null) {
        expect(json).not.toContain(s.refund_id);
        expect(json).toContain(`…${s.refund_id.slice(-4)}`);
      }
    }
    const full = await money.readLedgerList(MFA, q);
    const fullJson = JSON.stringify(full);
    for (const s of stored) expect(fullJson).toContain(s.capture_id);
    const sales = JSON.stringify(
      await money.readLedgerList(PLAIN, {
        environment: 'sandbox',
        currency: units[2]!.currency,
        kind: 'platform_fee',
      }),
    );
    expect(sales).not.toContain(sandboxCapture);
  });

  it('the ledger list carries no buyer identity, with or without the second factor', async () => {
    const ids = (
      await w.app.db.query<{ id: string; display_name: string }>(
        'SELECT id, display_name FROM buyers',
      )
    ).rows;
    for (const actor of [MFA, PLAIN]) {
      const json = JSON.stringify(
        await money.readLedgerList(actor, {
          environment: 'dryrun',
          currency: units[0]!.currency,
          kind: 'sale',
        }),
      );
      for (const b of ids) {
        expect(json).not.toContain(b.id);
        expect(json).not.toContain(b.display_name);
      }
    }
  });

  it('a bad query and a non operator get null', async () => {
    expect(
      await money.readLedgerList(MFA, { environment: 'live', currency: 'USD', kind: 'sale' }),
    ).toBeNull();
    expect(
      await money.readLedgerList(w.actorA, {
        environment: 'dryrun',
        currency: 'USD',
        kind: 'sale',
      }),
    ).toBeNull();
    expect(await money.readMoneyTotals(w.actorA)).toBeNull();
  });

  it('the reconciler state equals the job health read, and the rates are the stored ones', async () => {
    const read = await money.readMoneyTotals(MFA);
    const h = await w.app.engine.health();
    expect(read!.reconciler).toEqual({ last_pass_at: h.last_pass_at, due: h.due });
    const rates = await w.app.engine.fx.getRates();
    expect(read!.rates).toEqual(rates);
  });
});

describe('the pages', () => {
  it('the money page keeps its blocks and adds the totals by kind from ops-money, with EnvLabel', () => {
    const src = code('app/ops/money/page.tsx');
    expect(src).toContain('<RefundPanel');
    expect(src).toContain('readMoneyTotals(');
    expect(src).toMatch(/<EnvLabel environment=\{t\.environment\}/);
  });
  it('the ledger page reads ops-money, refuses a bad query with notFound and labels from the stored value', () => {
    const src = code('app/ops/money/ledger/page.tsx');
    expect(src).toMatch(/from '[./]+\/composition\/ops-money'/);
    expect(src).toContain('readLedgerList(');
    expect(src).toContain('notFound(');
    expect(src).toMatch(/<EnvLabel environment=\{/);
  });
});
