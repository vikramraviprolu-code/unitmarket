// INT-OPS-A / OPS-A.5: the case pages against the wrong visitor. A buyer, a seller and a visitor land on sign-in
// before any case is read; a case read for a non operator is null; the queue never carries the message text; the
// message is plain text whatever it holds; and a view for a session without the second factor has no buyer name,
// no provider id and no address, however the case was written.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { caseDetailView, caseQueueView, caseQuery, parseCaseFilter } from './lib/ops-cases-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const EVIL = '<img src=x onerror=alert(1)> {{7*7}} ${process.env} javascript:alert(2)';
let w: RefundWorld;
let buyers: typeof import('./composition/ops-buyers');
let unit: BoughtUnit;
let buyerName = '';
let ids: string[] = [];

beforeAll(async () => {
  w = await bootRefundWorld();
  buyers = await import('./composition/ops-buyers');
  unit = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
  const at = '2026-11-05T10:00:00.000Z';
  await w.app.db.query(
    `INSERT INTO recovery_cases (id, kind, state, order_id, entitlement_id, buyer_id, opened_by, sla_due_at, credit_ms, buyer_message, created_at, updated_at)
     SELECT 'cas_evil', 'refund_requested', 'open', id, NULL, buyer_id, 'buyer', $2::timestamptz, 0, $3::text, $2::timestamptz, $2::timestamptz FROM orders WHERE id = $1`,
    [unit.order_id, at, EVIL],
  );
  buyerName = (
    await w.app.db.query<{ n: string }>(
      'SELECT display_name AS n FROM buyers WHERE id = (SELECT buyer_id FROM orders WHERE id = $1)',
      [unit.order_id],
    )
  ).rows[0]!.n;
  ids = (
    await w.app.db.query<{ v: string }>(
      'SELECT provider_order_id AS v FROM provider_orders WHERE order_id = $1',
      [unit.order_id],
    )
  ).rows.map((r) => r.v);
});
afterAll(async () => w.app.close());

describe('who may read a case', () => {
  it('the files exist, and the Buyers redirect is there', () => {
    for (const f of [
      'app/ops/buyers/page.tsx',
      'app/ops/buyers/cases/page.tsx',
      'app/ops/buyers/cases/[id]/page.tsx',
      'ui/ops/CaseCard.tsx',
    ])
      expect(existsSync(join(here, f)), f).toBe(true);
  });

  it.each(['app/ops/buyers/cases/page.tsx', 'app/ops/buyers/cases/[id]/page.tsx'])(
    '%s sends a buyer, a seller and a visitor to sign in before it reads anything',
    (f) => {
      const page = source(f);
      expect(page).toMatch(/actor\?\.kind !== 'operator'\) redirect\(/);
      expect(page.indexOf("actor?.kind !== 'operator'")).toBeLessThan(
        page.search(/await read[A-Z]/),
      );
    },
  );

  it('the case reads answer null for a buyer, a seller and the system, even with a valid case id', async () => {
    for (const actor of [
      w.actorA,
      w.actorB,
      { kind: 'publisher', publisher_id: 'pub_x' },
      { kind: 'system' },
    ] as const)
      expect(await buyers.readCasePage(actor as never, 'cas_evil')).toBeNull();
    expect(
      await buyers.readCasePage(
        { kind: 'operator', operator_id: 'opr_demo', mfa: false },
        'cas_evil',
      ),
    ).not.toBeNull();
  });
});

describe('what a case shows', () => {
  it('the queue row carries no message text, no buyer and no provider id', async () => {
    const f = parseCaseFilter({});
    const q = await buyers.readCaseQueue(caseQuery(f));
    const text = JSON.stringify(caseQueueView(q, f, '2026-11-05T12:00:00.000Z'));
    expect(text).not.toContain('onerror');
    expect(text).not.toContain(buyerName);
    for (const id of ids) expect(text).not.toContain(id);
  });

  it('the message is kept as typed: plain text, never HTML, never run', async () => {
    const p = (await buyers.readCasePage(
      { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
      'cas_evil',
    ))!;
    const v = caseDetailView(p.detail, { mfa: true, keys: p.keys });
    expect(v.buyer_message!.text).toBe(EVIL);
    for (const f of [
      'ui/ops/CaseCard.tsx',
      'app/ops/buyers/cases/[id]/page.tsx',
      'app/ops/buyers/cases/page.tsx',
    ])
      expect(source(f)).not.toMatch(/dangerouslySetInnerHTML|innerHTML|\.html\(/);
  });

  it('a case with no message shows no message block', async () => {
    const view = caseDetailView(
      {
        case_id: 'cas_n',
        kind: 'frozen_order',
        state: 'open',
        sla_due_at: '2026-11-05T10:00:00.000Z',
        order_ref: null,
        credit_ms: 0,
        opened_by: 'system',
        alerts: [],
        allowed_actions: [],
        buyer_message_present: false,
      },
      { mfa: false, keys: {} },
    );
    expect(view.buyer_message).toBeNull();
    expect(view.order_href).toBeNull();
  });

  it('a session without the second factor sees nothing that names a person', async () => {
    const p = (await buyers.readCasePage(
      { kind: 'operator', operator_id: 'opr_demo', mfa: false },
      'cas_evil',
    ))!;
    const text = JSON.stringify(caseDetailView(p.detail, { mfa: false, keys: p.keys }));
    expect(text).not.toContain(buyerName);
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/ip_hash|buyer_id|publisher_id|capture_id|provider_order_id/);
  });
});
