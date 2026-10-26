// DP-4 golden (MVP-D, OQ-16, D-06): the receipt of one order of two PayPal orders, one per publisher.
// One receipt per order; each item line names its publisher (by display name, never a merchant id)
// and says what happened to its payment: paid, waiting, not charged, on hold, refunded or partly
// refunded. "Not charged" is said only of a declined, failed or abandoned PayPal order; a frozen one
// is on hold whether or not a capture was sent (OQ-8, H1). Rendered lines are compared with the
// hand-reviewed file golden/composite-receipt.golden.txt: a change to it is a change to what the
// buyer is shown. Synthetic rows only.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentHash } from '@umsbx/approval';
import type { ApprovalSnapshot, Receipt } from '@umsbx/contracts';
import { appendLedgerEntry } from '@umsbx/ledger';
import { getReceiptForBuyer, issueReceiptIfChanged, renderReceiptHtml } from './index';
import { DEBUG_ID, FIVE_DAYS_MS, makeWorld } from './world';
import type { World } from './world';

type PoState =
  | 'prepared'
  | 'awaiting_buyer'
  | 'approved'
  | 'capture_requested'
  | 'capture_claimed'
  | 'unresolved'
  | 'captured'
  | 'declined'
  | 'frozen'
  | 'failed'
  | 'abandoned';

const HARBOUR = { id: 'pub_1', name: 'Harbour Ledger', merchant: 'SBXPAYEEHARBOUR1' };
const QUAYSIDE = { id: 'pub_2', name: 'Quayside Press', merchant: 'SBXPAYEEQUAYSIDE2' };
const money = (minor: number): string => `USD ${(minor / 100).toFixed(2)}`;

function packSnapshot(n: number): ApprovalSnapshot {
  const item = (
    k: number,
    p: typeof HARBOUR,
    option: 'keep_retrieve' | 'online_read',
    amount: number,
  ) => ({
    article_id: `art_${n}_${k}`,
    article_sha256: String(k).repeat(64),
    offer_id: `ofr_${n}_${k}`,
    offer_version: '1',
    terms_version: 'terms-1',
    publisher_id: p.id,
    payee_merchant_id: p.merchant,
    option,
    policy: {
      id: `pol_${option}`,
      version: 'v1',
      option,
      window_ms: FIVE_DAYS_MS,
      start_rule: 'payment_verified_and_delivery_ready' as const,
    },
    rights: {
      scope: 'personal_use' as const,
      ai_scope: 'review' as const,
      redistribution: false as const,
    },
    amount_minor: amount,
  });
  return {
    snapshot_version: '1',
    items: [item(1, HARBOUR, 'keep_retrieve', 400), item(2, QUAYSIDE, 'online_read', 250)],
    publishers: [
      {
        publisher_id: HARBOUR.id,
        payee_merchant_id: HARBOUR.merchant,
        amount_minor: 400,
        platform_fee_minor: 0,
      },
      {
        publisher_id: QUAYSIDE.id,
        payee_merchant_id: QUAYSIDE.merchant,
        amount_minor: 250,
        platform_fee_minor: 0,
      },
    ],
    total_minor: 650,
    currency: 'USD',
    corridor_id: 'us-usd',
    reader: { buyer_id: 'buy_A' },
    rule_version: 'rules-1',
    pricing_rule_version: 'pricing-1',
    settlement: { route: 'per_publisher', payments: 2 },
  };
}

interface Pack {
  n: number;
  order_id: string;
  units: { harbour: string; quayside: string };
  captures: { harbour: string; quayside: string };
}

/**
 * An order of two PayPal orders, one unit each. `po1` and `po2` are the states of the two PayPal
 * orders; a `captured` one has a verified unit, a capture id, a sale entry and an access window. A
 * `frozen` one has its unit in mismatch.
 */
async function pack(w: World, n: number, po1: PoState, po2: PoState): Promise<Pack> {
  const T = () => w.clock.now().toISOString();
  const snapshot = packSnapshot(n);
  const hash = contentHash(snapshot);
  await w.insert('approvals', {
    id: `apr_${n}`,
    buyer_id: 'buy_A',
    snapshot: JSON.stringify(snapshot),
    content_hash: hash,
    nonce: `nonce${n}`,
    expires_at: new Date(w.clock.now().getTime() + 900_000).toISOString(),
    used_at: null,
    environment: w.deps.environment,
  });
  for (const it of snapshot.items) {
    await w.insert('articles', {
      id: it.article_id,
      publisher_id: it.publisher_id,
      title: 't',
      abstract: 'a',
      language: 'en',
      topics: ['x'],
      published_at: T(),
      sha256: it.article_sha256,
      content_key: `k_${it.article_id}`,
      bytes: 10,
      mime: 'text/plain',
    });
  }
  const states = [po1, po2];
  const any = states.includes('captured');
  const order_status = states.every((s) => s === 'captured')
    ? 'paid'
    : any
      ? 'paid_partial'
      : 'capture_requested';
  await w.insert('orders', {
    id: `ord_${n}`,
    approval_id: `apr_${n}`,
    buyer_id: 'buy_A',
    content_hash: hash,
    order_ref: `ref_${n}`,
    expected: '{}',
    status: order_status,
    mismatch: states.includes('frozen'),
    corridor_id: 'us-usd',
    currency: 'USD',
    total_minor: 650,
    environment: w.deps.environment,
  });
  const pubs = [HARBOUR, QUAYSIDE];
  const amounts = [400, 250];
  const out = { units: { harbour: '', quayside: '' }, captures: { harbour: '', quayside: '' } };
  for (const [i, state] of states.entries()) {
    const pub = pubs[i]!;
    const key = i === 0 ? 'harbour' : 'quayside';
    const captured = state === 'captured';
    const po_id = `por_${n}_${i + 1}`;
    await w.insert('provider_orders', {
      id: po_id,
      order_id: `ord_${n}`,
      provider_order_id: `SBXPPORDER${n}X${i + 1}`,
      route: 'per_publisher',
      approve_url: null,
      status: captured ? 'COMPLETED' : 'CREATED',
      position: i + 1,
      po_ref: `ref_${n}-p${i + 1}`,
      publisher_id: pub.id,
      state,
      first_approved_at: null,
    });
    const unit_id = `unt_${n}_${i + 1}`;
    const capture_id = `CAP${n}X${i + 1}`;
    out.units[key] = unit_id;
    out.captures[key] = capture_id;
    const unit_status = captured
      ? 'captured_verified'
      : state === 'frozen'
        ? 'mismatch'
        : state === 'declined' || state === 'failed' || state === 'abandoned'
          ? 'declined'
          : 'expected';
    await w.insert('order_units', {
      id: unit_id,
      order_id: `ord_${n}`,
      provider_order_ref: po_id,
      publisher_id: pub.id,
      reference_id: `refid_${n}_${i + 1}`,
      payee_merchant_id: pub.merchant,
      amount_minor: amounts[i],
      platform_fee_minor: 0,
      capture_id: captured ? capture_id : null,
      status: unit_status,
      status_reason: null,
      paypal_fee_minor: null,
      refunded_minor: 0,
      captured_verified_at: captured ? T() : null,
      mismatch_reason: state === 'frozen' ? 'payee' : null,
    });
    const ent_id = `ent_${n}_${i + 1}`;
    const item = snapshot.items[i]!;
    await w.insert('entitlements', {
      id: ent_id,
      buyer_id: 'buy_A',
      article_id: item.article_id,
      unit_id,
      option: item.option,
      policy: JSON.stringify(item.policy),
      money_state: captured ? 'captured' : unit_status === 'declined' ? 'denied' : 'pending',
      access_state: captured ? 'available' : 'locked',
      licence_state: captured ? 'granted' : null,
      transition_log: '[]',
      environment: w.deps.environment,
    });
    await w.insert('access_windows', {
      entitlement_id: ent_id,
      state: captured ? 'running' : 'not_started',
      started_at: captured ? '2026-10-22T10:00:00.000Z' : null,
      base_ends_at: captured ? '2026-10-27T10:00:00.000Z' : null,
      ends_at: captured ? '2026-10-27T10:00:00.000Z' : null,
      paused_at: null,
      credit_ms: 0,
    });
    if (captured) {
      await w.insert('operations', {
        id: `opr_${n}_${i + 1}`,
        order_id: `ord_${n}`,
        unit_id,
        kind: 'capture',
        state: 'confirmed',
        attempt: 0,
        request_id: `req_${n}_${i + 1}`,
      });
      await w.insert('provider_calls', {
        id: `pcl_${n}_${i + 1}`,
        operation_id: `opr_${n}_${i + 1}`,
        operation: 'capture_order',
        method: 'POST',
        path_template: '/v2/checkout/orders/{id}/capture',
        http_status: 201,
        outcome: 'ok',
        debug_id: DEBUG_ID,
        duration_ms: 5,
        transport_kind: 'dryrun',
        request_redacted: '{}',
        response_redacted: '{}',
        environment: w.deps.environment,
      });
      await appendLedgerEntry(w.db, w.deps, {
        unit_id,
        capture_id,
        kind: 'sale',
        amount: { currency: 'USD', minor: amounts[i]! },
        refund_id: null,
        ref_entry_id: null,
      });
    }
  }
  return { n, order_id: `ord_${n}`, ...out };
}

const issue = (w: World, order_id: string) =>
  w.db.transaction((tx) => issueReceiptIfChanged(tx, w.deps, { order_id }));
const receiptOf = async (w: World, order_id: string, version?: number): Promise<Receipt> => {
  const r = await getReceiptForBuyer(w.db, {
    order_id,
    buyer_id: 'buy_A',
    ...(version === undefined ? {} : { version }),
  });
  if (r === null) throw new Error('no receipt');
  return r;
};
const cell = (html: string, label: string): string[] =>
  [...html.matchAll(new RegExp(`<dt>${label}</dt><dd>([^<]*)</dd>`, 'g'))].map((m) => m[1]!);

/** One golden block: the facts a buyer reads, from the receipt and its page. */
function block(title: string, r: Receipt): string[] {
  const html = renderReceiptHtml(r);
  const names = cell(html, 'Publisher');
  const pay = cell(html, 'Payment');
  return [
    `== ${title}`,
    `version: ${r.version}`,
    `environment: ${r.environment}`,
    `label: ${/<p><strong>([^<]*)<\/strong><\/p>/.exec(html)![1]}`,
    `total: ${money(r.snapshot.total_minor)}`,
    ...r.lines.map(
      (l, i) =>
        `line: ${l.article_id} | ${l.publisher_display_name} | ${l.option} | ${money(l.amount_minor)} | ${l.outcome} | ${names[i]} | ${pay[i]}`,
    ),
  ];
}

let w: World;
beforeAll(async () => {
  w = await makeWorld('cmp');
  await w.db.query(
    "UPDATE publishers SET display_name = 'Harbour Ledger', paypal_merchant_id = 'SBXPAYEEHARBOUR1' WHERE id = 'pub_1'",
  );
  await w.insert('publishers', {
    id: 'pub_2',
    slug: 'p2',
    display_name: 'Quayside Press',
    country: 'US',
    paypal_merchant_id: 'SBXPAYEEQUAYSIDE2',
    payee_verified_at: w.clock.now().toISOString(),
  });
});
afterAll(async () => {
  await w.close();
});

const GOLDEN = readFileSync(
  new URL('./golden/composite-receipt.golden.txt', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l !== '' && !l.startsWith('#'));
const lines: string[] = [];

describe('composite receipt (golden)', () => {
  it('receipt after PO1 verified: Harbour paid, Quayside waiting', async () => {
    const p = await pack(w, 1, 'captured', 'awaiting_buyer');
    expect((await issue(w, p.order_id)).ok).toBe(true);
    const r = await receiptOf(w, p.order_id);
    expect(r.lines.map((l) => [l.publisher_display_name, l.outcome])).toEqual([
      ['Harbour Ledger', 'paid'],
      ['Quayside Press', 'waiting'],
    ]);
    // one receipt per order, however many PayPal orders
    expect(r.version).toBe(1);
    lines.push(...block('after PO1 verified', r));
  });

  it('after PO2 declined: Quayside not charged', async () => {
    const p = await pack(w, 2, 'captured', 'declined');
    await issue(w, p.order_id);
    const r = await receiptOf(w, p.order_id);
    expect(r.lines.map((l) => l.outcome)).toEqual(['paid', 'not_charged']);
    expect(renderReceiptHtml(r)).toContain('You were not charged for this item');
    // the Harbour line is never marked
    expect(renderReceiptHtml(r).match(/You were not charged for this item/g)).toHaveLength(1);
    lines.push(...block('after PO2 declined', r));
  });

  it('after a PO2 hold: on hold, never not charged', async () => {
    const p = await pack(w, 3, 'captured', 'frozen');
    await issue(w, p.order_id);
    const r = await receiptOf(w, p.order_id);
    expect(r.lines.map((l) => l.outcome)).toEqual(['paid', 'on_hold']);
    const html = renderReceiptHtml(r);
    expect(html).toContain('On hold while we check it');
    expect(html).not.toContain('not charged');
    lines.push(...block('after a PO2 hold', r));
  });

  it('labels Dry run and Sandbox from environment', async () => {
    const dry = await receiptOf(w, 'ord_1');
    expect(dry.environment).toBe('dryrun');
    expect(renderReceiptHtml(dry)).toContain('<p><strong>Dry run</strong></p>');
    expect(() => renderReceiptHtml(dry, 'Sandbox')).toThrow(/contradicts/);
    const s = await makeWorld('cms', 'sandbox');
    try {
      await s.db.query("UPDATE publishers SET display_name = 'Harbour Ledger' WHERE id = 'pub_1'");
      await s.insert('publishers', {
        id: 'pub_2',
        slug: 'p2',
        display_name: 'Quayside Press',
        country: 'US',
        paypal_merchant_id: 'SBXPAYEEQUAYSIDE2',
        payee_verified_at: s.clock.now().toISOString(),
      });
      const p = await pack(s, 4, 'captured', 'awaiting_buyer');
      await issue(s, p.order_id);
      const r = await receiptOf(s, p.order_id);
      expect(r.environment).toBe('sandbox');
      expect(renderReceiptHtml(r)).toContain('<p><strong>Sandbox</strong></p>');
      expect(() => renderReceiptHtml(r, 'Dry run')).toThrow(/contradicts/);
      lines.push(...block('sandbox label', r));
    } finally {
      await s.close();
    }
  });

  it('no merchant id in body or HTML', async () => {
    const r = await receiptOf(w, 'ord_2');
    const html = renderReceiptHtml(r);
    // The frozen offer snapshot keeps its payee ids (it is the hashed approval; see the DP-4 report).
    // Nothing that DP-4 adds, and nothing the buyer reads, names a merchant.
    const shown = JSON.stringify({ lines: r.lines, refunds: r.refunds, debug_ids: r.debug_ids });
    for (const id of ['SBXPAYEEHARBOUR1', 'SBXPAYEEQUAYSIDE2', 'MERCH']) {
      expect(shown).not.toContain(id);
      expect(html).not.toContain(id);
    }
    expect(Object.keys(r.lines[0]!).sort()).toEqual(
      [
        'amount_minor',
        'article_id',
        'article_sha256',
        'capture_id',
        'delivery',
        'option',
        'outcome',
        'publisher_display_name',
        'window',
      ].sort(),
    );
  });

  it('matches golden/composite-receipt.golden.txt', () => {
    expect(lines).toEqual(GOLDEN);
  });
});

describe('outcome per PayPal order state', () => {
  const cases: [PoState, string][] = [
    ['prepared', 'waiting'],
    ['awaiting_buyer', 'waiting'],
    ['approved', 'waiting'],
    ['capture_requested', 'waiting'],
    ['capture_claimed', 'waiting'],
    ['unresolved', 'waiting'],
    ['declined', 'not_charged'],
    ['failed', 'not_charged'],
    ['abandoned', 'not_charged'],
    ['frozen', 'on_hold'],
  ];
  let k = 100;
  for (const [state, outcome] of cases) {
    it(`PO2 ${state} reads ${outcome}${state === 'frozen' ? ' (on hold even though no capture was sent)' : ''}`, async () => {
      k += 1;
      const p = await pack(w, k, 'captured', state);
      await issue(w, p.order_id);
      const r = await receiptOf(w, p.order_id);
      expect(r.lines[1]!.outcome).toBe(outcome);
      expect(r.lines[0]!.outcome).toBe('paid');
      const html = renderReceiptHtml(r);
      expect(html.includes('You were not charged for this item')).toBe(outcome === 'not_charged');
      expect(html.includes('On hold while we check it')).toBe(outcome === 'on_hold');
    });
  }

  it('a captured PayPal order whose unit is in mismatch reads on hold, never paid and never not charged', async () => {
    const p = await pack(w, 150, 'captured', 'captured');
    await w.db.query("UPDATE order_units SET status = 'mismatch' WHERE id = $1", [
      p.units.quayside,
    ]);
    await issue(w, p.order_id);
    const r = await receiptOf(w, p.order_id);
    expect(r.lines[1]!.outcome).toBe('on_hold');
  });

  it('a verified capture under a PayPal order closed as not charged reads on hold, never paid and never not charged', async () => {
    const p = await pack(w, 155, 'captured', 'captured');
    await w.db.query("UPDATE provider_orders SET state = 'declined' WHERE id = 'por_155_2'");
    await issue(w, p.order_id);
    const r = await receiptOf(w, p.order_id);
    expect(r.lines.map((l) => l.outcome)).toEqual(['paid', 'on_hold']);
    expect(renderReceiptHtml(r)).not.toContain('You were not charged');
  });

  it('a publisher name is escaped on the page', async () => {
    await w.db.query("UPDATE publishers SET display_name = $1 WHERE id = 'pub_2'", [
      '<script>alert(1)</script> & "Co"',
    ]);
    try {
      const p = await pack(w, 156, 'captured', 'awaiting_buyer');
      await issue(w, p.order_id);
      const html = renderReceiptHtml(await receiptOf(w, p.order_id));
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;');
    } finally {
      await w.db.query("UPDATE publishers SET display_name = 'Quayside Press' WHERE id = 'pub_2'");
    }
  });

  it('a refund moves only the line of its own publisher', async () => {
    const p = await pack(w, 160, 'captured', 'captured');
    await issue(w, p.order_id);
    const book = async (unit: string, capture: string, refund_id: string, minor: number) => {
      await appendLedgerEntry(w.db, w.deps, {
        unit_id: unit,
        capture_id: capture,
        kind: 'refund',
        amount: { currency: 'USD', minor },
        refund_id,
        ref_entry_id: null,
      });
      await w.db.query(
        `UPDATE order_units SET refunded_minor = refunded_minor + $2,
                status = CASE WHEN refunded_minor + $2 >= amount_minor THEN 'refunded' ELSE 'partially_refunded' END
          WHERE id = $1`,
        [unit, minor],
      );
    };
    await book(p.units.harbour, p.captures.harbour, 'RFH', 100);
    await issue(w, p.order_id);
    let r = await receiptOf(w, p.order_id);
    expect(r.lines.map((l) => l.outcome)).toEqual(['partially_refunded', 'paid']);
    await book(p.units.quayside, p.captures.quayside, 'RFQ', 250);
    await issue(w, p.order_id);
    r = await receiptOf(w, p.order_id);
    expect(r.lines.map((l) => l.outcome)).toEqual(['partially_refunded', 'refunded']);
    expect(r.version).toBe(3);
    // each version keeps what it said
    expect((await receiptOf(w, p.order_id, 1)).lines.map((l) => l.outcome)).toEqual([
      'paid',
      'paid',
    ]);
  });

  it('a new version is issued when a payment outcome changes, and the old one is not edited', async () => {
    const p = await pack(w, 170, 'captured', 'awaiting_buyer');
    const first = await issue(w, p.order_id);
    expect(first.ok && first.value.changed).toBe(true);
    const again = await issue(w, p.order_id);
    expect(again.ok && again.value.changed).toBe(false);
    await w.db.query("UPDATE provider_orders SET state = 'declined' WHERE id = $1", [`por_170_2`]);
    const next = await issue(w, p.order_id);
    expect(next.ok && next.value.version).toBe(2);
    expect((await receiptOf(w, p.order_id, 1)).lines[1]!.outcome).toBe('waiting');
    expect((await receiptOf(w, p.order_id, 2)).lines[1]!.outcome).toBe('not_charged');
  });

  it('another buyer never gets the receipt of this order', async () => {
    const r = await getReceiptForBuyer(w.db, { order_id: 'ord_1', buyer_id: 'buy_B' });
    expect(r).toBeNull();
  });
});

describe('single-publisher receipts are unchanged', () => {
  it('a one-publisher order has no publisher_display_name and no outcome on any line', async () => {
    const o = await w.order(900);
    await issue(w, o.order_id);
    const r = await receiptOf(w, o.order_id);
    expect(r.lines.length).toBe(2);
    for (const l of r.lines) {
      expect(Object.keys(l).sort()).toEqual(
        [
          'amount_minor',
          'article_id',
          'article_sha256',
          'capture_id',
          'delivery',
          'option',
          'window',
        ].sort(),
      );
    }
    expect(renderReceiptHtml(r)).not.toContain('<dt>Publisher</dt>');
    expect(renderReceiptHtml(r)).not.toContain('<dt>Payment</dt>');
  });

  it('a stored body written before DP-4 (no new keys) still parses, verifies and renders', async () => {
    const o = await w.order(901);
    await issue(w, o.order_id);
    const r = await receiptOf(w, o.order_id);
    expect(r.version).toBe(1);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => renderReceiptHtml(r)).not.toThrow();
  });
});
