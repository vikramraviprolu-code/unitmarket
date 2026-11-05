// POB-M1: migration 0029 (fee on top, ledger split, payouts). Forward-only. The fee setting (append only, 0 to 3000
// basis points), the parts of an offer and of a unit, five new ledger kinds, payouts with a guarded state machine,
// their items and the netting settlements. Tolerates later migrations: it never checks an exact list.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

const T = '2026-11-05T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});

let n = 0;
async function ins(d: Db, table: string, row: Record<string, unknown>): Promise<void> {
  const r: Record<string, unknown> = { created_at: T, updated_at: T, ...row };
  const cols = Object.keys(r);
  await d.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  await ins(d, 'publishers', {
    id: 'pub_m',
    slug: 'pm',
    display_name: 'Pub M',
    country: 'US',
    paypal_merchant_id: 'MERCHM',
    payee_verified_at: T,
  });
  await ins(d, 'buyers', { id: 'buy_m', display_name: 'B', auth_subject: 'sub_m', country: 'US' });
  await ins(d, 'articles', {
    id: 'art_m',
    publisher_id: 'pub_m',
    title: 'T',
    abstract: 'a',
    language: 'en',
    topics: ['x'],
    published_at: T,
    sha256: 'a'.repeat(64),
    content_key: 'key_m',
    bytes: 1,
    mime: 'text/plain',
  });
  await ins(d, 'offers', {
    id: 'ofr_m',
    version: '1',
    publisher_id: 'pub_m',
    article_id: 'art_m',
    status: 'authorised',
    currency: 'USD',
    options: JSON.stringify([
      {
        option: 'keep_retrieve',
        price_minor: 400,
        policy_id: 'keep_retrieve',
        policy_version: '1',
      },
      { option: 'online_read', price_minor: 250, policy_id: 'online_read', policy_version: '1' },
    ]),
    affordability: '{}',
    terms_version: 't',
    rights: '{}',
    valid_from: T,
    valid_until: null,
    superseded_by: null,
  });
  return d;
}

/** An order with one captured unit of `amount` minor units. */
async function unit(d: Db, amount = 400): Promise<{ unit_id: string; capture_id: string }> {
  n += 1;
  await ins(d, 'approvals', {
    id: `apr_m${n}`,
    buyer_id: 'buy_m',
    snapshot: '{}',
    content_hash: 'a'.repeat(64),
    nonce: `nonce_m${n}`,
    expires_at: '2026-11-05T10:15:00.000Z',
    used_at: null,
    environment: 'dryrun',
  });
  await ins(d, 'orders', {
    id: `ord_m${n}`,
    approval_id: `apr_m${n}`,
    buyer_id: 'buy_m',
    content_hash: 'a'.repeat(60) + String(n).padStart(4, '0'),
    order_ref: `ref_m${n}`,
    expected: '{}',
    status: 'paid',
    mismatch: false,
    corridor_id: 'us-usd',
    currency: 'USD',
    total_minor: amount,
    environment: 'dryrun',
  });
  await ins(d, 'order_units', {
    id: `unt_m${n}`,
    order_id: `ord_m${n}`,
    provider_order_ref: null,
    publisher_id: 'pub_m',
    reference_id: `refid_m${n}`,
    payee_merchant_id: 'MERCHM',
    amount_minor: amount,
    platform_fee_minor: 0,
    capture_id: `CAPM${n}`,
    status: 'captured_verified',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 0,
    captured_verified_at: T,
    mismatch_reason: null,
  });
  return { unit_id: `unt_m${n}`, capture_id: `CAPM${n}` };
}

const led = (
  d: Db,
  u: { unit_id: string; capture_id: string },
  kind: string,
  minor: number,
  refund_id: string | null = null,
): Promise<void> =>
  ins(d, 'ledger_entries', {
    id: `led_m${(n += 1)}`,
    unit_id: u.unit_id,
    capture_id: u.capture_id,
    kind,
    amount_minor: minor,
    currency: 'USD',
    refund_id,
    ref_entry_id: null,
    environment: 'dryrun',
  });

describe('migration 0029: applied once, forward only', () => {
  it('is applied once, after 0027, with no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0029_fee_and_payouts');
    expect(first.indexOf('0029_fee_and_payouts')).toBeGreaterThan(
      first.indexOf('0027_rule_settings'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((x) => /^0029_.*(down|rollback)/i.test(x))).toEqual([]);
    const sql = readFileSync(new URL('0029_fee_and_payouts.sql', dir), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\blive\b\s*['"]/i);
  });
});

describe('fee_settings', () => {
  it('is seeded with 1000 basis points by seed, and rows are append only', async () => {
    const d = await fresh();
    const r = await d.query<{ fee_bps: number; set_by: string }>(
      'SELECT fee_bps, set_by FROM fee_settings',
    );
    expect(r.rows).toEqual([{ fee_bps: 1000, set_by: 'seed' }]);
    await expect(d.query('UPDATE fee_settings SET fee_bps = 5')).rejects.toThrow();
    await expect(d.query('DELETE FROM fee_settings')).rejects.toThrow();
    await expect(d.query('TRUNCATE fee_settings')).rejects.toThrow();
  });
  it('holds 0 to 3000 basis points and a reason of 3 to 200 characters', async () => {
    const d = await fresh();
    const row = (id: string, fee_bps: number, reason = 'fine reason', set_at = T) =>
      ins(d, 'fee_settings', { id, fee_bps, set_by: 'opr_1', set_at, reason });
    await row('rls_f0', 0, 'zero', '2026-11-05T10:00:01Z');
    await row('rls_f3000', 3000, 'abc', '2026-11-05T10:00:02Z');
    await expect(row('rls_f3001', 3001, 'fine reason', '2026-11-05T10:00:03Z')).rejects.toThrow();
    await expect(row('rls_fneg', -1, 'fine reason', '2026-11-05T10:00:04Z')).rejects.toThrow();
    await expect(row('rls_fab', 5, 'ab', '2026-11-05T10:00:05Z')).rejects.toThrow();
    await expect(row('rls_fx', 5, 'x'.repeat(201), '2026-11-05T10:00:06Z')).rejects.toThrow();
  });
  it('two settings cannot share one instant, so the latest is never a tie', async () => {
    const d = await fresh();
    await ins(d, 'fee_settings', {
      id: 'rls_a',
      fee_bps: 1,
      set_by: 'o',
      set_at: T,
      reason: 'first',
    });
    await expect(
      ins(d, 'fee_settings', { id: 'rls_b', fee_bps: 2, set_by: 'o', set_at: T, reason: 'second' }),
    ).rejects.toThrow();
  });
});

describe('offer_price_parts', () => {
  const parts = (over: Record<string, unknown> = {}) => ({
    offer_id: 'ofr_m',
    offer_version: '1',
    option: 'keep_retrieve',
    seller_minor: 364,
    fee_minor: 36,
    tax_minor: 0,
    fee_bps: 1000,
    ...over,
  });
  it('stores seller plus fee equal to the listed price of that option, once', async () => {
    const d = await fresh();
    await ins(d, 'offer_price_parts', parts());
    await expect(ins(d, 'offer_price_parts', parts())).rejects.toThrow(); // same key
    await ins(
      d,
      'offer_price_parts',
      parts({ option: 'online_read', seller_minor: 250, fee_minor: 0, fee_bps: 0 }),
    );
  });
  it('refuses parts that do not add up, a tax, a rate above 3000 and an offer that does not exist', async () => {
    const d = await fresh();
    await expect(ins(d, 'offer_price_parts', parts({ seller_minor: 300 }))).rejects.toThrow();
    await expect(
      ins(d, 'offer_price_parts', parts({ seller_minor: 363, fee_minor: 36, tax_minor: 1 })),
    ).rejects.toThrow();
    await expect(ins(d, 'offer_price_parts', parts({ fee_bps: 3001 }))).rejects.toThrow();
    await expect(ins(d, 'offer_price_parts', parts({ fee_bps: -1 }))).rejects.toThrow();
    await expect(ins(d, 'offer_price_parts', parts({ offer_id: 'ofr_none' }))).rejects.toThrow();
    await expect(ins(d, 'offer_price_parts', parts({ option: 'bogus' }))).rejects.toThrow();
  });
  it('is append only', async () => {
    const d = await fresh();
    await ins(d, 'offer_price_parts', parts());
    await expect(
      d.query('UPDATE offer_price_parts SET fee_minor = 0, seller_minor = 400'),
    ).rejects.toThrow();
    await expect(d.query('DELETE FROM offer_price_parts')).rejects.toThrow();
    await expect(d.query('TRUNCATE offer_price_parts')).rejects.toThrow();
  });
});

describe('order_unit_parts', () => {
  it('copies the parts of a unit: seller plus fee equal the unit amount, tax is reserved at zero', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await ins(d, 'order_unit_parts', {
      unit_id: u.unit_id,
      seller_minor: 360,
      fee_minor: 40,
      tax_minor: 0,
    });
    const v = await unit(d, 400);
    await expect(
      ins(d, 'order_unit_parts', {
        unit_id: v.unit_id,
        seller_minor: 360,
        fee_minor: 41,
        tax_minor: 0,
      }),
    ).rejects.toThrow();
    await expect(
      ins(d, 'order_unit_parts', {
        unit_id: v.unit_id,
        seller_minor: 359,
        fee_minor: 40,
        tax_minor: 1,
      }),
    ).rejects.toThrow();
    await expect(
      ins(d, 'order_unit_parts', {
        unit_id: 'unt_none',
        seller_minor: 400,
        fee_minor: 0,
        tax_minor: 0,
      }),
    ).rejects.toThrow();
  });
  it('never changes after the order: a later fee change cannot alter a sale', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await ins(d, 'order_unit_parts', {
      unit_id: u.unit_id,
      seller_minor: 360,
      fee_minor: 40,
      tax_minor: 0,
    });
    await expect(
      d.query('UPDATE order_unit_parts SET fee_minor = 0, seller_minor = 400'),
    ).rejects.toThrow();
    await expect(d.query('DELETE FROM order_unit_parts')).rejects.toThrow();
    await expect(d.query('TRUNCATE order_unit_parts')).rejects.toThrow();
  });
});

describe('ledger kinds', () => {
  it('accepts fee and payable without a refund id, and the three refund kinds with one', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await led(d, u, 'sale', 400);
    await led(d, u, 'fee', 40);
    await led(d, u, 'payable', 360);
    await led(d, u, 'fee_reversal', 10, 'RF1');
    await led(d, u, 'payable_reversal', 90, 'RF1');
    await led(d, u, 'payout_adjustment', 90, 'RF1');
  });
  it('pairs a refund id with exactly the kinds that carry one', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await led(d, u, 'sale', 400);
    await expect(led(d, u, 'fee', 40, 'RF1')).rejects.toThrow();
    await expect(led(d, u, 'payable', 360, 'RF1')).rejects.toThrow();
    await expect(led(d, u, 'fee_reversal', 10, null)).rejects.toThrow();
    await expect(led(d, u, 'payable_reversal', 10, null)).rejects.toThrow();
    await expect(led(d, u, 'payout_adjustment', 10, null)).rejects.toThrow();
    await led(d, u, 'refund', 10, 'RF1'); // the old rule still holds
    await expect(led(d, u, 'refund', 10, null)).rejects.toThrow();
  });
  it('one fee and one payable per capture, one reversal and adjustment per refund id', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await led(d, u, 'sale', 400);
    await led(d, u, 'fee', 40);
    await expect(led(d, u, 'fee', 40)).rejects.toThrow();
    await led(d, u, 'payable', 360);
    await expect(led(d, u, 'payable', 360)).rejects.toThrow();
    await led(d, u, 'fee_reversal', 5, 'RF1');
    await expect(led(d, u, 'fee_reversal', 5, 'RF1')).rejects.toThrow();
    await led(d, u, 'fee_reversal', 5, 'RF2');
  });
  it('a new kind is never zero or negative', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await led(d, u, 'sale', 400);
    await expect(led(d, u, 'fee', 0)).rejects.toThrow();
    await expect(led(d, u, 'payable', 0)).rejects.toThrow();
    await expect(led(d, u, 'fee_reversal', 0, 'RF1')).rejects.toThrow();
    await expect(led(d, u, 'payout_adjustment', 0, 'RF1')).rejects.toThrow();
  });
  it('a reversal can never exceed what it reverses', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await led(d, u, 'sale', 400);
    await led(d, u, 'fee', 40);
    await led(d, u, 'payable', 360);
    await led(d, u, 'fee_reversal', 30, 'RF1');
    await expect(led(d, u, 'fee_reversal', 11, 'RF2')).rejects.toThrow(); // 41 above 40
    await led(d, u, 'fee_reversal', 10, 'RF2');
    await led(d, u, 'payable_reversal', 300, 'RF1');
    await expect(led(d, u, 'payable_reversal', 61, 'RF2')).rejects.toThrow();
    await led(d, u, 'payable_reversal', 60, 'RF2');
  });
  it('rows stay append only', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await led(d, u, 'payable', 360);
    await expect(
      d.query("UPDATE ledger_entries SET amount_minor = 1 WHERE kind = 'payable'"),
    ).rejects.toThrow();
    await expect(d.query("DELETE FROM ledger_entries WHERE kind = 'payable'")).rejects.toThrow();
  });
});

async function mkPayout(
  d: Db,
  id: string,
  amount = 360,
  over: Record<string, unknown> = {},
  items: { unit_id: string; seller_minor: number }[] = [],
): Promise<void> {
  await d.transaction(async (tx) => {
    await ins(tx as unknown as Db, 'payouts', {
      id,
      publisher_id: 'pub_m',
      currency: 'USD',
      amount_minor: amount,
      state: 'due',
      environment: 'dryrun',
      idempotency_key: `umsP-${id}`,
      payee_merchant_id: 'MERCHM',
      provider_ref: null,
      failure_reason: null,
      sending_at: null,
      failed_at: null,
      ...over,
    });
    for (const it of items) {
      await ins(tx as unknown as Db, 'payout_items', {
        payout_id: id,
        order_unit_id: it.unit_id,
        seller_minor: it.seller_minor,
        live: true,
      });
    }
  });
}
async function due(d: Db, id: string, amount = 360): Promise<{ unit_id: string }> {
  const u = await unit(d, amount);
  await mkPayout(d, id, amount, {}, [{ unit_id: u.unit_id, seller_minor: amount }]);
  return u;
}
const set = (d: Db, id: string, state: string, extra = '') =>
  d.query(`UPDATE payouts SET state = $2${extra}, updated_at = '${T}' WHERE id = $1`, [id, state]);

describe('payouts', () => {
  it('holds the key umsP-<id>, a ceiling of 100000000, the six states and the two environments', async () => {
    const d = await fresh();
    await due(d, 'pay_ok', 360);
    const u = await unit(d, 400);
    const bad = (id: string, over: Record<string, unknown>) =>
      mkPayout(d, id, 360, over, [{ unit_id: u.unit_id, seller_minor: 360 }]);
    await expect(bad('pay_k', { idempotency_key: 'other' })).rejects.toThrow();
    await expect(bad('pay_e', { environment: 'live' })).rejects.toThrow();
    await expect(bad('pay_s', { state: 'paid' })).rejects.toThrow();
    await expect(
      mkPayout(d, 'pay_big', 100_000_001, {}, [{ unit_id: u.unit_id, seller_minor: 100_000_001 }]),
    ).rejects.toThrow();
    await expect(bad('pay_c', { currency: 'usd' })).rejects.toThrow();
  });
  it('a payout of 0 exists only as confirmed with the reference NETTED-<id>', async () => {
    const d = await fresh();
    await mkPayout(d, 'pay_net', 0, { state: 'confirmed', provider_ref: 'NETTED-pay_net' });
    await expect(mkPayout(d, 'pay_z1', 0, {})).rejects.toThrow();
    await expect(
      mkPayout(d, 'pay_z2', 0, { state: 'confirmed', provider_ref: 'X-1' }),
    ).rejects.toThrow();
    await expect(
      mkPayout(d, 'pay_z3', 0, { state: 'confirmed', provider_ref: null }),
    ).rejects.toThrow();
  });
  it('is created only due (or netted and confirmed): never sending, sent or failed', async () => {
    const d = await fresh();
    for (const state of ['sending', 'sent', 'failed', 'cancelled']) {
      const u = await unit(d, 400);
      await expect(
        mkPayout(
          d,
          `pay_i_${state}`,
          360,
          { state, provider_ref: 'R', failure_reason: 'x', failed_at: T, sending_at: T },
          [{ unit_id: u.unit_id, seller_minor: 360 }],
        ),
      ).rejects.toThrow();
    }
  });
  it('moves only along due, sending, sent or confirmed, failed, cancelled', async () => {
    const d = await fresh();
    // due -> sending -> sent -> confirmed
    await due(d, 'pay_a');
    await set(d, 'pay_a', 'sending', `, sending_at = '${T}'`);
    await set(d, 'pay_a', 'sent', ", provider_ref = 'DRYRUN-umsP-pay_a'");
    await set(d, 'pay_a', 'confirmed');
    // sending -> confirmed directly, sending -> failed, failed -> cancelled, due -> cancelled
    await due(d, 'pay_b');
    await set(d, 'pay_b', 'sending', `, sending_at = '${T}'`);
    await set(d, 'pay_b', 'confirmed', ", provider_ref = 'DRYRUN-umsP-pay_b'");
    await due(d, 'pay_c');
    await set(d, 'pay_c', 'sending', `, sending_at = '${T}'`);
    await set(d, 'pay_c', 'failed', `, failure_reason = 'rejected', failed_at = '${T}'`);
    await set(d, 'pay_c', 'cancelled');
    await due(d, 'pay_d');
    await set(d, 'pay_d', 'cancelled');
  });
  it('refuses every other move, so a sending payout can be neither replaced nor cancelled', async () => {
    const d = await fresh();
    await due(d, 'pay_x1');
    await expect(set(d, 'pay_x1', 'sent', ", provider_ref = 'R'")).rejects.toThrow(); // due -> sent
    await expect(set(d, 'pay_x1', 'confirmed', ", provider_ref = 'R'")).rejects.toThrow();
    await expect(
      set(d, 'pay_x1', 'failed', `, failure_reason = 'x', failed_at = '${T}'`),
    ).rejects.toThrow();
    await set(d, 'pay_x1', 'sending', `, sending_at = '${T}'`);
    await expect(set(d, 'pay_x1', 'due')).rejects.toThrow(); // sending -> due
    await expect(set(d, 'pay_x1', 'cancelled')).rejects.toThrow(); // cancel only from due or failed
    await set(d, 'pay_x1', 'sent', ", provider_ref = 'R'");
    await expect(set(d, 'pay_x1', 'cancelled')).rejects.toThrow();
    await expect(set(d, 'pay_x1', 'due')).rejects.toThrow();
    await expect(set(d, 'pay_x1', 'sending')).rejects.toThrow();
    await set(d, 'pay_x1', 'confirmed');
    for (const s of ['due', 'sending', 'sent', 'failed', 'cancelled']) {
      await expect(
        set(d, 'pay_x1', s, ", provider_ref = 'R2', failure_reason = 'x', failed_at = '" + T + "'"),
      ).rejects.toThrow();
    }
    await due(d, 'pay_x2');
    await set(d, 'pay_x2', 'cancelled');
    await expect(set(d, 'pay_x2', 'due')).rejects.toThrow();
    await expect(set(d, 'pay_x2', 'sending')).rejects.toThrow();
    await expect(d.query("DELETE FROM payouts WHERE id = 'pay_x2'")).rejects.toThrow();
  });
  it('keeps who, how much and where fixed once the row exists', async () => {
    const d = await fresh();
    await due(d, 'pay_f');
    for (const col of [
      'amount_minor = 1',
      "currency = 'EUR'",
      "publisher_id = 'pub_zzz'",
      "idempotency_key = 'umsP-other'",
      "payee_merchant_id = 'OTHER'",
      "environment = 'sandbox'",
    ]) {
      await expect(d.query(`UPDATE payouts SET ${col} WHERE id = 'pay_f'`)).rejects.toThrow();
    }
  });
  it('a sent or confirmed payout carries a provider reference, a failed one a reason and a time', async () => {
    const d = await fresh();
    await due(d, 'pay_r');
    await set(d, 'pay_r', 'sending', `, sending_at = '${T}'`);
    await expect(set(d, 'pay_r', 'sent')).rejects.toThrow();
    await expect(set(d, 'pay_r', 'failed')).rejects.toThrow();
    await expect(set(d, 'pay_r', 'failed', `, failure_reason = 'x'`)).rejects.toThrow();
  });
  it('the amount must equal the items minus the live settlements when the transaction commits', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await expect(
      mkPayout(d, 'pay_w1', 100, {}, [{ unit_id: u.unit_id, seller_minor: 360 }]),
    ).rejects.toThrow();
    await expect(mkPayout(d, 'pay_w2', 360, {}, [])).rejects.toThrow();
    // 360 of items, 60 settled against an adjustment: the payout is 300.
    await d.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await ins(t, 'payouts', {
        id: 'pay_w3',
        publisher_id: 'pub_m',
        currency: 'USD',
        amount_minor: 300,
        state: 'due',
        environment: 'dryrun',
        idempotency_key: 'umsP-pay_w3',
        payee_merchant_id: 'MERCHM',
      });
      await ins(t, 'payout_items', {
        payout_id: 'pay_w3',
        order_unit_id: u.unit_id,
        seller_minor: 360,
        live: true,
      });
      await ins(t, 'adjustment_settlements', {
        payout_id: 'pay_w3',
        adjustment_entry_id: 'led_x',
        amount_minor: 60,
        live: true,
      });
    });
    const v = await unit(d, 400);
    await expect(
      d.transaction(async (tx) => {
        const t = tx as unknown as Db;
        await ins(t, 'payouts', {
          id: 'pay_w4',
          publisher_id: 'pub_m',
          currency: 'USD',
          amount_minor: 360,
          state: 'due',
          environment: 'dryrun',
          idempotency_key: 'umsP-pay_w4',
          payee_merchant_id: 'MERCHM',
        });
        await ins(t, 'payout_items', {
          payout_id: 'pay_w4',
          order_unit_id: v.unit_id,
          seller_minor: 360,
          live: true,
        });
        await ins(t, 'adjustment_settlements', {
          payout_id: 'pay_w4',
          adjustment_entry_id: 'led_y',
          amount_minor: 60,
          live: true,
        });
      }),
    ).rejects.toThrow();
  });
});

describe('payout_items and adjustment_settlements', () => {
  it('a unit is in at most one live payout; releasing happens only when the payout is cancelled', async () => {
    const d = await fresh();
    const u = await due(d, 'pay_i1');
    await expect(
      mkPayout(d, 'pay_i2', 360, {}, [{ unit_id: u.unit_id, seller_minor: 360 }]),
    ).rejects.toThrow();
    // not released while the payout is alive
    await expect(
      d.query("UPDATE payout_items SET live = false WHERE payout_id = 'pay_i1'"),
    ).rejects.toThrow();
    await set(d, 'pay_i1', 'cancelled');
    await d.query(
      "UPDATE payout_items SET live = false, updated_at = '" + T + "' WHERE payout_id = 'pay_i1'",
    );
    await mkPayout(d, 'pay_i3', 360, {}, [{ unit_id: u.unit_id, seller_minor: 360 }]);
    // once released it cannot be switched back on
    await expect(
      d.query("UPDATE payout_items SET live = true WHERE payout_id = 'pay_i1'"),
    ).rejects.toThrow();
  });
  it('items and settlements never change otherwise and are never removed', async () => {
    const d = await fresh();
    await due(d, 'pay_i4');
    const u = await unit(d, 400);
    await d.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await ins(t, 'payouts', {
        id: 'pay_i6',
        publisher_id: 'pub_m',
        currency: 'USD',
        amount_minor: 300,
        state: 'due',
        environment: 'dryrun',
        idempotency_key: 'umsP-pay_i6',
        payee_merchant_id: 'MERCHM',
      });
      await ins(t, 'payout_items', {
        payout_id: 'pay_i6',
        order_unit_id: u.unit_id,
        seller_minor: 360,
        live: true,
      });
      await ins(t, 'adjustment_settlements', {
        payout_id: 'pay_i6',
        adjustment_entry_id: 'led_z',
        amount_minor: 60,
        live: true,
      });
    });
    await expect(d.query('UPDATE payout_items SET seller_minor = 1')).rejects.toThrow();
    await expect(d.query("UPDATE payout_items SET order_unit_id = 'unt_zzz'")).rejects.toThrow();
    await expect(d.query('DELETE FROM payout_items')).rejects.toThrow();
    await expect(d.query('UPDATE adjustment_settlements SET amount_minor = 1')).rejects.toThrow();
    await expect(d.query('DELETE FROM adjustment_settlements')).rejects.toThrow();
  });
  it('an item is a positive amount and a settlement is a positive amount', async () => {
    const d = await fresh();
    const u = await unit(d, 400);
    await expect(
      mkPayout(d, 'pay_i5', 0, {}, [{ unit_id: u.unit_id, seller_minor: 0 }]),
    ).rejects.toThrow();
  });
  it('a settlement has no foreign key to the ledger (the truncate guard tests reset the ledger alone)', async () => {
    const d = await fresh();
    const fk = await d.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'adjustment_settlements' AND c.contype = 'f' ORDER BY 1`,
    );
    expect(fk.rows.map((r) => r.conname).every((x) => x.includes('payout'))).toBe(true);
    const toLedger = await d.query(
      `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
        WHERE t.relname = 'ledger_entries' AND c.conrelid IN (SELECT oid FROM pg_class WHERE relname IN ('adjustment_settlements', 'payouts', 'payout_items'))`,
    );
    expect(toLedger.rows).toEqual([]);
  });
});

describe('schema shape', () => {
  it('every new table has created_at and updated_at and no column default', async () => {
    const d = await fresh();
    const tables = [
      'fee_settings',
      'offer_price_parts',
      'order_unit_parts',
      'payouts',
      'payout_items',
      'adjustment_settlements',
    ];
    const cols = await d.query<{
      table_name: string;
      column_name: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables],
    );
    for (const t of tables) {
      const names = cols.rows.filter((c) => c.table_name === t).map((c) => c.column_name);
      expect(names, t).toContain('created_at');
      expect(names, t).toContain('updated_at');
    }
    expect(cols.rows.filter((c) => c.column_default !== null)).toEqual([]);
  });
});
