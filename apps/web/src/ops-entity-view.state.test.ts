// INT-OPS-C / OPS-C.1 and OPS-C.2: the operator buyer page /ops/buyers/[id] and seller page /ops/sellers/[id].
// The buyer page is identity by definition, so it needs a session with the second factor; without it the read
// answers only the notice. The seller page shows offers, sales, payee status and agreement version, and no buyer
// identity anywhere (deep scan). Each read wraps the upstream reads (SR1 list, the stored rows) in its own
// composition module.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld, buy, postRefund } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { newAgent } from './app/api/v1/mcp/agent-test-support';
import { OPS_MFA_NOTICE, maskId } from './lib/ops-entity-view';

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
let buyers: typeof import('./composition/ops-buyers');
let sellers: typeof import('./composition/ops-sellers');
let buyerA = '';
let buyerB = '';
let nameA = '';
let nameB = '';
let pubId = '';
let agentKey = '';
let mandateId = '';
const units: BoughtUnit[] = [];

beforeAll(async () => {
  w = await bootRefundWorld();
  buyers = await import('./composition/ops-buyers');
  sellers = await import('./composition/ops-sellers');
  buyerA = (w.actorA as { buyer_id: string }).buyer_id;
  buyerB = (w.actorB as { buyer_id: string }).buyer_id;
  const names = await w.app.db.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM buyers WHERE id = ANY($1::text[])',
    [[buyerA, buyerB]],
  );
  nameA = names.rows.find((r) => r.id === buyerA)!.display_name;
  nameB = names.rows.find((r) => r.id === buyerB)!.display_name;
  units.push(await buy(w, { offer: 'knot-notebook', option: 'online_read' }));
  units.push(await buy(w, { offer: 'harbour-fees', option: 'online_read' }));
  units.push(await buy(w, { offer: 'tide-tables', option: 'online_read', who: 'B' }));
  const refund = await postRefund(w, w.op, {
    unit_id: units[0]!.unit_id,
    amount_minor: null,
    reason: 'Customer asked for a refund',
  });
  if (refund.status !== 200) throw new Error(`refund ${refund.status}`);
  const agent = await newAgent(w.app, w.actorA, {
    mandate: { max_count: 4, max_total_minor: 900 },
  });
  agentKey = agent.key_id;
  mandateId = agent.mandate!.id;
  pubId = (
    await w.app.db.query<{ id: string }>("SELECT id FROM publishers WHERE slug = 'harbour-ledger'")
  ).rows[0]!.id;
});
afterAll(async () => w.app.close());

describe('maskId and the notice', () => {
  it('maskId keeps the last four characters after an ellipsis', () => {
    expect(maskId('key_0123456789abcdefghjkmnpqrs')).toBe('…pqrs');
    expect(maskId('abc')).toBe('…abc');
    expect(maskId(null)).toBeNull();
  });
  it('the notice says the page needs the authenticator code', () => {
    expect(OPS_MFA_NOTICE).toContain('needs your authenticator code');
  });
});

describe('OPS-C.1 the buyer page', () => {
  it('with the second factor lists the buyer orders, library count, refunds, caps and keys', async () => {
    const r = await buyers.readBuyerPage(MFA, buyerA);
    if (r === null || r.kind !== 'page') throw new Error('expected a page');
    expect(r.buyer).toMatchObject({ id: buyerA, display_name: nameA });
    expect(r.orders.map((o) => o.order_ref).sort()).toEqual(
      [units[0]!.order_ref, units[1]!.order_ref].sort(),
    );
    expect(r.orders.map((o) => o.order_ref)).not.toContain(units[2]!.order_ref);
    const ents = await w.app.db.query<{ c: string }>(
      'SELECT count(*) AS c FROM entitlements WHERE buyer_id = $1',
      [buyerA],
    );
    expect(r.library_count).toBe(Number(ents.rows[0]!.c));
    expect(r.library_count).toBeGreaterThanOrEqual(2);
    expect(r.refunds).toHaveLength(1);
    expect(r.refunds[0]).toMatchObject({
      order_ref: units[0]!.order_ref,
      state: 'completed',
      currency: units[0]!.currency,
    });
    expect(r.caps.map((c) => c.id)).toEqual([mandateId]);
    expect(r.caps[0]).toMatchObject({
      agent_key: agentKey,
      max_count: 4,
      max_total_minor: 900,
      spent_minor: 0,
      used_count: 0,
      remaining_count: 4,
      remaining_total_minor: 900,
      state: 'active',
    });
    expect(r.keys.map((k) => k.id)).toContain(agentKey);
    expect(['dryrun', 'sandbox']).toContain(r.environment);
  });

  it('carries no other buyer and no secret', async () => {
    const r = await buyers.readBuyerPage(MFA, buyerA);
    const json = JSON.stringify(r);
    expect(json).not.toContain(buyerB);
    expect(json).not.toContain(nameB);
    expect(json).not.toMatch(/secret_hash|whsec_/);
    const hash = (
      await w.app.db.query<{ secret_hash: string }>(
        'SELECT secret_hash FROM api_keys WHERE id = $1',
        [agentKey],
      )
    ).rows[0]!.secret_hash;
    expect(json).not.toContain(hash);
  });

  it('without the second factor answers only the notice, with no row of the buyer', async () => {
    const r = await buyers.readBuyerPage(PLAIN, buyerA);
    expect(r).toEqual({ kind: 'mfa_required', notice: OPS_MFA_NOTICE });
    const json = JSON.stringify(r);
    for (const v of [buyerA, nameA, units[0]!.order_ref, agentKey, mandateId])
      expect(json).not.toContain(v);
  });

  it('is null for a non operator and for an unknown buyer', async () => {
    expect(await buyers.readBuyerPage(w.actorA, buyerA)).toBeNull();
    expect(
      await buyers.readBuyerPage({ kind: 'publisher', publisher_id: pubId }, buyerA),
    ).toBeNull();
    expect(await buyers.readBuyerPage(MFA, 'buy_unknown_0000')).toBeNull();
  });
});

describe('OPS-C.2 the seller page', () => {
  it('lists the seller offers, sales, payee status and agreement version', async () => {
    for (const actor of [MFA, PLAIN]) {
      const r = await sellers.readSellerPage(actor, pubId);
      if (r === null) throw new Error('expected a page');
      expect(r.seller.id).toBe(pubId);
      const offers = await w.app.db.query<{ id: string }>(
        'SELECT DISTINCT id FROM offers WHERE publisher_id = $1',
        [pubId],
      );
      expect(r.offers.map((o) => o.id).sort()).toEqual(offers.rows.map((o) => o.id).sort());
      expect(r.sales.map((s) => s.order_ref).sort()).toEqual(units.map((u) => u.order_ref).sort());
      expect(typeof r.payee.verified).toBe('boolean');
      const agr = await w.app.db.query<{ terms_version: string }>(
        'SELECT terms_version FROM publisher_agreements WHERE publisher_id = $1 ORDER BY accepted_at DESC, id DESC LIMIT 1',
        [pubId],
      );
      expect(r.agreement?.terms_version ?? null).toBe(agr.rows[0]?.terms_version ?? null);
      expect(r.mfa).toBe(actor === MFA);
    }
  });

  it('shows no buyer identity, with or without the second factor (deep scan)', async () => {
    for (const actor of [MFA, PLAIN]) {
      const r = await sellers.readSellerPage(actor, pubId);
      const json = JSON.stringify(r);
      for (const v of [buyerA, buyerB, nameA, nameB, agentKey, mandateId])
        expect(json, `${actor.kind} ${String((actor as { mfa: boolean }).mfa)}`).not.toContain(v);
      expect(json).not.toMatch(/buyer_id|buyer_display_name|agent_key_id|mandate_id/);
    }
  });

  it('without the second factor the merchant id is the last four only and no PayPal id is whole', async () => {
    const r = await sellers.readSellerPage(PLAIN, pubId);
    const json = JSON.stringify(r);
    const merchant = (
      await w.app.db.query<{ paypal_merchant_id: string | null }>(
        'SELECT paypal_merchant_id FROM publishers WHERE id = $1',
        [pubId],
      )
    ).rows[0]!.paypal_merchant_id;
    if (merchant !== null) {
      expect(json).not.toContain(merchant);
      expect(r!.payee.merchant).toBe(maskId(merchant));
    }
    for (const u of units) {
      const cap = (
        await w.app.db.query<{ capture_id: string | null }>(
          'SELECT capture_id FROM order_units WHERE id = $1',
          [u.unit_id],
        )
      ).rows[0]!.capture_id;
      if (cap !== null) expect(json).not.toContain(cap);
    }
  });

  it('is null for a non operator and for an unknown seller', async () => {
    expect(await sellers.readSellerPage(w.actorA, pubId)).toBeNull();
    expect(await sellers.readSellerPage(MFA, 'pub_unknown_0000')).toBeNull();
  });
});

describe('the pages are thin and read through their tab module', () => {
  it('the buyer page imports ops-buyers and shows the notice without the code', () => {
    const src = code('app/ops/buyers/[id]/page.tsx');
    expect(src).toMatch(/from '[./]+\/composition\/ops-buyers'/);
    expect(src).toContain('readBuyerPage(');
    expect(src).toContain('notFound(');
    expect(src).toMatch(/mfa_required/);
  });
  it('the seller page imports ops-sellers and uses EntitySummary', () => {
    const src = code('app/ops/sellers/[id]/page.tsx');
    expect(src).toMatch(/from '[./]+\/composition\/ops-sellers'/);
    expect(src).toContain('readSellerPage(');
    expect(src).toContain('<EntitySummary');
    expect(src).toContain('notFound(');
  });
});
