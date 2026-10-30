// PUB-C: the sales and statement engine methods and the S4 and S5 pages. The engine is driven through a
// real offline app (dry run order model, PGlite); the pages are .tsx files the unit runner does not
// compile, so their source is read as text.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPasscode } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const PSALT = 'ffeeddccbbaa99887766554433221100';
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

let w: RefundWorld;
let bought: BoughtUnit;
let harbour: Actor;
let quayside: Actor;

async function publisher(persona: string): Promise<Actor> {
  const s = await w.app.engine.signIn({ persona, passcode: PUBLISHER_PASSCODE });
  if (s === null) throw new Error(`no sign in for ${persona}`);
  return s.actor;
}

beforeAll(async () => {
  w = await bootRefundWorld({
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(PUBLISHER_PASSCODE, PSALT),
  });
  bought = await buy(w, { offer: 'tide-tables', option: 'keep_retrieve' });
  harbour = await publisher('publisher-harbour-ledger');
  quayside = await publisher('publisher-quayside-gazette');
});
afterAll(async () => {
  await w.app.close();
});

describe('engine.publisherSales', () => {
  it('lists the units of the signed-in publisher, from stored rows, and none for another publisher', async () => {
    const rows = await w.app.engine.publisherSales(harbour);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({
      amount_minor: bought.amount_minor,
      currency: bought.currency,
      status: 'captured_verified',
      status_text: 'Paid',
      environment: 'dryrun',
      order_ref6: bought.order_ref.slice(-6),
    });
    expect(await w.app.engine.publisherSales(quayside)).toEqual([]);
  });

  it('answers null for a buyer, an operator and a system actor', async () => {
    expect(await w.app.engine.publisherSales(w.actorA)).toBeNull();
    expect(
      await w.app.engine.publisherSales({ kind: 'operator', operator_id: 'opr_x', mfa: true }),
    ).toBeNull();
    expect(await w.app.engine.publisherStatement(w.actorA)).toBeNull();
  });

  it('carries no buyer identity', async () => {
    const text = JSON.stringify([
      await w.app.engine.publisherSales(harbour),
      await w.app.engine.publisherStatement(harbour),
    ]);
    const buyerId = w.actorA.kind === 'buyer' ? w.actorA.buyer_id : '';
    expect(buyerId).not.toBe('');
    expect(text).not.toContain(buyerId);
    expect(text).not.toMatch(/persona:buyer|Buyer A|buyer-a/i);
  });
});

describe('engine.publisherStatement', () => {
  it('sums the ledger rows of the publisher per currency and labels them from the stored environment', async () => {
    const st = await w.app.engine.publisherStatement(harbour);
    expect(st).not.toBeNull();
    expect(st!.blocks).toHaveLength(1);
    expect(st!.blocks[0]).toMatchObject({
      currency: bought.currency,
      environment: 'dryrun',
      sales_minor: bought.amount_minor,
      refunds_minor: 0,
      reversals_minor: 0,
      net_minor: bought.amount_minor,
    });
    expect(st!.blocks[0]!.settlement.mode).toBe('dryrun');
    expect(st!.commission).toBe('No commission in this demo; planned 20 percent, not implemented.');
    expect(st!.blocks[0]!.lines.map((l) => l.kind)).toContain('sale');
  });

  it('shows nothing of another publisher, and an empty statement still has the settlement and commission lines', async () => {
    const st = await w.app.engine.publisherStatement(quayside);
    expect(st!.blocks).toEqual([]);
    expect(st!.environment).toBe(w.app.environment);
    expect(st!.settlement.mode).toBe('dryrun');
    expect(st!.commission).toContain('planned 20 percent');
  });
});

describe('pages S4 and S5', () => {
  const pages = ['./app/publisher/sales/page.tsx', './app/publisher/statement/page.tsx'] as const;

  it.each(pages)('%s reads no request parameter, so no id can come from the client', (p) => {
    const src = read(p).replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/searchParams|params|headers\(|cookies\(/);
    expect(src).toMatch(/currentActor\(\)/);
    expect(src).toMatch(/actor\?\.kind !== 'publisher'\) redirect\('\/signin\?next=\/publisher\//);
  });

  it.each(pages)(
    '%s has no inline style, no external resource and no typed environment word',
    (p) => {
      const src = read(p).replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/style=|<script|<img|https?:\/\/|<i>|<em>/);
      expect(src).not.toMatch(/Sandbox|Dry run/);
      expect(src).toMatch(/EnvLabel/);
    },
  );

  it('S4 reads the sales through the engine and shows the empty state and the fee words from copy', () => {
    const src = read('./app/publisher/sales/page.tsx');
    expect(src).toContain('engine.publisherSales(actor)');
    expect(src).toContain('SALES_EMPTY_TITLE');
    expect(src).toContain('FEE_NOT_REPORTED');
    expect(src).toContain('SALES_SOURCE_NOTE');
    expect(src).toMatch(/id=\{`order-/);
  });

  it('S5 reads the statement through the engine and shows settlement, commission and a source note per line', () => {
    const src = read('./app/publisher/statement/page.tsx');
    expect(src).toContain('engine.publisherStatement(actor)');
    expect(src).toContain('settlement.sentence');
    expect(src).toContain('commission');
    expect(src).toContain('LINE_SOURCE');
    expect(src).toContain('salesAnchor(');
    expect(src).toContain('STATEMENT_EMPTY_TITLE');
  });
});
