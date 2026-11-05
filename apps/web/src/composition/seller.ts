// INT-UI0 / UI0.7: the composition module of the seller tabs.
// INT-TR1 adds the seller timeline of one unit, from the journal.
// INT-SEL adds the rest of the seller reads: the sale detail, the sales list and its CSV, the Home figures, the
// setup path, Money, the offer pages and per-option performance.
//
// Rules this module keeps (spec int-sel.md):
//   F2  Every seller read drops `order_total_minor`, even though SR0's seller columns no longer carry it. A seller
//       sees no order total, no buyer and no other seller's unit.
//   F3  Net is the statement net: gross (the sale row) minus refunds minus reversals, over `ledger_entries`.
//       The PayPal fee is shown beside it and never subtracted. A unit that holds several articles counts
//       toward each offer it holds, its money split evenly with the remainder to the lowest offer id (R2-1).
//       `offers` has one row per version, so the offer ids of a unit are taken distinct (R2-2).
//   F4  Every window comes from the injected Clock, in UTC, and filters on `captured_verified_at`.
//   F1  A refund shows amount, state and date. `refund_requests.reason` is operator free text and is never read.
import type { Actor, TxnLine } from '@umsbx/contracts';
import {
  TRACE_WORDS,
  TxnSearchError,
  UNIT_STATUS_TEXT,
  app,
  exportName,
  exportTransactions,
  isPlainQuery,
  listTransactions,
  sellerLine,
  txnCsv,
} from '../server/access';
import type { TimelineEntryView } from '../lib/timeline-view';
import type { SellerSale } from '../lib/seller-sale-view';
import { sellerWindows, setupDone, setupSteps } from '../lib/seller-home-view';
import type {
  AgentShare,
  SellerHomeRead,
  SetupStep,
  TopOffer,
  WeekFigures,
} from '../lib/seller-home-view';
import { offerShare, perOffer, perOption, topOffersFrom } from '../lib/seller-offer-view';
import type { OfferFigures, OptionFigures, UnitMoney } from '../lib/seller-offer-view';
import { salesTabQuery } from '../lib/seller-sales-view';
import type { SalesCounts } from '../lib/seller-sales-view';
import type { MoneyBlockRead } from '../lib/seller-money-view';
import { blockLabels } from '../lib/seller-money-view';

const statusText = (status: string): string =>
  Object.hasOwn(UNIT_STATUS_TEXT, status)
    ? (UNIT_STATUS_TEXT as Readonly<Record<string, string>>)[status]!
    : status;

type SellerActor = Extract<Actor, { kind: 'publisher' }>;
type Db = Awaited<ReturnType<typeof app>>['db'];

const sellerOf = (actor: Actor | null): SellerActor | null =>
  actor !== null && actor.kind === 'publisher' ? actor : null;

const num = (v: unknown): number => Number(v ?? 0);

/** The steps of one unit for the seller who sold it. Null for another seller's unit or an unknown one. */
export async function readSellerTimeline(publisher_id: string, unit_id: string) {
  return (await app()).trace.sellerTimeline({ unit_id, publisher_id });
}

// ---------- refusals ----------

export interface Refused {
  kind: 'refused';
  status: 400 | 403;
  code: string;
  message: string;
}
export interface Forbidden {
  kind: 'forbidden';
}

function refusalOf(e: unknown): Refused | null {
  if (e instanceof TxnSearchError) {
    return { kind: 'refused', status: e.status, code: e.code, message: e.message };
  }
  if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TxnSearchError') {
    const t = e as { status: 400 | 403; code: string; message: string };
    return { kind: 'refused', status: t.status, code: t.code, message: t.message };
  }
  return null;
}

/** F2: a seller line never carries the order total or a buyer column, whatever the line builder returns. */
function stripLine(l: TxnLine): TxnLine {
  const out: Record<string, unknown> = { ...l };
  for (const k of [
    'order_total_minor',
    'buyer_id',
    'buyer_display_name',
    'agent_key_id',
    'mandate_id',
    'seller_name',
    'seller_slug',
    'publisher_id',
  ])
    delete out[k];
  return out as unknown as TxnLine;
}

// ---------- SEL.2 the sales list and its CSV ----------

export interface SellerSalesRead {
  kind: 'ok';
  lines: TxnLine[];
  next_cursor: string | null;
  counts: SalesCounts;
}

async function countOf(
  db: Db,
  actor: SellerActor,
  raw: Record<string, string>,
  now: Date,
): Promise<number> {
  const r = await exportTransactions(db, actor, raw, { now });
  return r.rows.length;
}

export async function readSellerSales(
  actor: Actor | null,
  raw: Record<string, string>,
): Promise<SellerSalesRead | Refused | Forbidden> {
  const seller = sellerOf(actor);
  if (seller === null) return { kind: 'forbidden' };
  const a = await app();
  const now = a.security.clock.now();
  try {
    const r = await listTransactions(a.db, seller, raw, { now });
    const counts: SalesCounts = {
      all: await countOf(a.db, seller, salesTabQuery('all'), now),
      pending: await countOf(a.db, seller, salesTabQuery('pending'), now),
      refunds: await countOf(a.db, seller, salesTabQuery('refunds'), now),
    };
    return {
      kind: 'ok',
      lines: r.rows.map((row) => stripLine(sellerLine(row, now))),
      next_cursor: r.next_cursor,
      counts,
    };
  } catch (e) {
    const refused = refusalOf(e);
    if (refused !== null) return refused;
    throw e;
  }
}

export interface SellerExport {
  kind: 'ok';
  filename: string;
  csv: string;
  truncated: boolean;
}

/** The current filter as CSV text: no buyer column, no order total, every cell made safe (txnCsv). */
export async function exportSellerSales(
  actor: Actor | null,
  raw: Record<string, string>,
): Promise<SellerExport | Refused | Forbidden> {
  const seller = sellerOf(actor);
  if (seller === null) return { kind: 'forbidden' };
  const a = await app();
  const now = a.security.clock.now();
  try {
    const r = await exportTransactions(a.db, seller, raw, { now });
    return {
      kind: 'ok',
      filename: exportName('seller', now),
      csv: txnCsv(
        'seller',
        r.rows.map((row) => stripLine(sellerLine(row, now))),
      ),
      truncated: r.truncated,
    };
  } catch (e) {
    const refused = refusalOf(e);
    if (refused !== null) return refused;
    throw e;
  }
}

/** True when a query holds no filter: the Sales page then lists every line, as SR1 does. */
export const isPlainSalesQuery = (raw: Record<string, string>): boolean => isPlainQuery(raw);

// ---------- SEL.1 the sale detail ----------

export type SellerSaleRead = { kind: 'ok'; sale: SellerSale } | { kind: 'not_found' } | Forbidden;

interface SaleRow {
  order_ref6: string;
  unit_status: string;
  created_at: string;
  captured_at: string | null;
  currency: string;
  environment: 'dryrun' | 'sandbox';
  channel: string;
}

export async function readSellerSale(
  actor: Actor | null,
  unit_id: string,
): Promise<SellerSaleRead> {
  const seller = sellerOf(actor);
  if (seller === null) return { kind: 'forbidden' };
  const a = await app();
  const timeline = await readSellerTimeline(seller.publisher_id, unit_id);
  if (timeline === null) return { kind: 'not_found' };
  const db = a.db;
  const row = (
    await db.query<SaleRow>(
      `SELECT order_ref6, unit_status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              to_char(captured_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
              currency, environment, channel
         FROM txn_rows WHERE unit_id = $1 AND publisher_id = $2`,
      [unit_id, seller.publisher_id],
    )
  ).rows[0];
  if (row === undefined) return { kind: 'not_found' };
  const sums = await db.query<{ kind: string; total: string | number }>(
    `SELECT kind, coalesce(sum(amount_minor), 0) AS total FROM ledger_entries WHERE unit_id = $1 GROUP BY kind`,
    [unit_id],
  );
  const sum = new Map(sums.rows.map((r) => [r.kind, num(r.total)]));
  const items = await db.query<{ title: string; option: string }>(
    `SELECT art.title, e.option FROM entitlements e JOIN articles art ON art.id = e.article_id
      WHERE e.unit_id = $1 ORDER BY art.title`,
    [unit_id],
  );
  // F1: state, amount and date of the latest refund. The reason column is not selected.
  const refund = (
    await db.query<{ state: string; amount_minor: number | null; at: string }>(
      `SELECT state, amount_minor, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM refund_requests WHERE unit_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [unit_id],
    )
  ).rows[0];
  const entries: TimelineEntryView[] = timeline.entries.map((e) => ({
    at: e.at,
    seq: e.seq,
    event_type: e.event_type,
    words_key: e.words_key,
    actor: { kind: e.actor.kind as TimelineEntryView['actor']['kind'], label: e.actor.label },
    channel: e.channel as TimelineEntryView['channel'],
    ...(e.amount_minor === undefined ? {} : { amount_minor: e.amount_minor }),
    ...(e.state_from === undefined ? {} : { state_from: e.state_from }),
    ...(e.state_to === undefined ? {} : { state_to: e.state_to }),
    source: { table: e.source.table, id: e.source.id },
    verified: e.verified,
  }));
  // Only the sentences of the steps shown, never the whole map.
  const words: Record<string, string> = {};
  for (const e of entries)
    if (Object.hasOwn(TRACE_WORDS, e.words_key)) words[e.words_key] = TRACE_WORDS[e.words_key]!;
  const paypalFee = sum.get('paypal_fee');
  return {
    kind: 'ok',
    sale: {
      unit_id,
      order_ref6: row.order_ref6,
      status_text: statusText(row.unit_status),
      created_at: row.created_at,
      captured_at: row.captured_at,
      currency: row.currency,
      environment: row.environment,
      channel: row.channel === 'agent' ? 'agent' : 'human',
      items: items.rows.map((i) => ({ title: i.title, option: i.option })),
      gross_minor: sum.get('sale') ?? 0,
      refunds_minor: sum.get('refund') ?? 0,
      reversals_minor: sum.get('reversal') ?? 0,
      paypal_fee_minor: paypalFee === undefined ? null : paypalFee,
      refund:
        refund === undefined
          ? null
          : {
              amount_minor: refund.amount_minor === null ? null : num(refund.amount_minor),
              state: refund.state,
              at: refund.at,
            },
      timeline: { entries, truncated: timeline.truncated },
      words,
    },
  };
}

// ---------- SEL.7, SEL.8 the money queries ----------

/**
 * The captured units of a seller with their ledger money and the offers they hold (R2-1, R2-2). `window` is
 * the half open interval [from, to) on `captured_verified_at`; without it every unit with a sale is read, and
 * `all` also reads units with no sale yet (the offer page lists a pending sale with no money).
 */
async function unitMoney(
  db: Db,
  publisher_id: string,
  window: { from: Date; to: Date } | null,
  all = false,
): Promise<UnitMoney[]> {
  const params: unknown[] = [publisher_id];
  let where = 't.publisher_id = $1';
  if (window !== null) {
    params.push(window.from.toISOString(), window.to.toISOString());
    where += ' AND t.captured_verified_at >= $2 AND t.captured_verified_at < $3';
  } else if (!all) {
    where += ' AND t.captured_verified_at IS NOT NULL';
  }
  const r = await db.query<{
    unit_id: string;
    currency: string;
    environment: 'dryrun' | 'sandbox';
    channel: string;
    gross: string | number;
    refunds: string | number;
    reversals: string | number;
    offers: unknown;
  }>(
    `SELECT t.unit_id, t.currency, t.environment, t.channel,
            (SELECT coalesce(sum(l.amount_minor), 0) FROM ledger_entries l WHERE l.unit_id = t.unit_id AND l.kind = 'sale') AS gross,
            (SELECT coalesce(sum(l.amount_minor), 0) FROM ledger_entries l WHERE l.unit_id = t.unit_id AND l.kind = 'refund') AS refunds,
            (SELECT coalesce(sum(l.amount_minor), 0) FROM ledger_entries l WHERE l.unit_id = t.unit_id AND l.kind = 'reversal') AS reversals,
            (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('offer_id', ofr.id, 'option', e.option)), '[]'::jsonb)
               FROM entitlements e
               JOIN offers ofr ON ofr.article_id = e.article_id AND ofr.publisher_id = t.publisher_id
              WHERE e.unit_id = t.unit_id) AS offers
       FROM txn_rows t
      WHERE ${where}
      ORDER BY t.unit_id`,
    params,
  );
  return r.rows.map((x): UnitMoney => {
    const offers = (typeof x.offers === 'string' ? JSON.parse(x.offers) : x.offers) as {
      offer_id: string;
      option: string;
    }[];
    return {
      unit_id: x.unit_id,
      currency: x.currency,
      environment: x.environment,
      channel: x.channel === 'agent' ? 'agent' : 'human',
      gross_minor: num(x.gross),
      refunds_minor: num(x.refunds),
      reversals_minor: num(x.reversals),
      offers,
    };
  });
}

/** Agent units over all units with a sale inside the window. */
export async function agentShare(publisher_id: string, from: Date, to: Date): Promise<AgentShare> {
  const r = await (
    await app()
  ).db.query<{ total: string | number; agent: string | number }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE channel = 'agent') AS agent
       FROM txn_rows WHERE publisher_id = $1 AND captured_verified_at >= $2 AND captured_verified_at < $3`,
    [publisher_id, from.toISOString(), to.toISOString()],
  );
  return { agent_units: num(r.rows[0]?.agent), total_units: num(r.rows[0]?.total) };
}

async function titlesOf(
  db: Db,
  publisher_id: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const r = await db.query<{ id: string; title: string }>(
    `SELECT DISTINCT ON (ofr.id) ofr.id, art.title
       FROM offers ofr JOIN articles art ON art.id = ofr.article_id
      WHERE ofr.publisher_id = $1 AND ofr.id = ANY($2::text[])
      ORDER BY ofr.id, ofr.created_at DESC, ofr.version DESC`,
    [publisher_id, [...ids]],
  );
  return new Map(r.rows.map((x) => [x.id, x.title]));
}

/** The best `n` offers by net, ties by offer id, over the sales inside the window. */
export async function topOffers(
  publisher_id: string,
  from: Date,
  to: Date,
  n: number,
): Promise<TopOffer[]> {
  const db = (await app()).db;
  const top = topOffersFrom(await unitMoney(db, publisher_id, { from, to }), n);
  const titles = await titlesOf(
    db,
    publisher_id,
    top.map((t) => t.offer_id),
  );
  return top.map((t) => ({ ...t, title: titles.get(t.offer_id) ?? t.offer_id }));
}

export type PerformanceRow = OptionFigures;

/** Units, gross, refunds and net per offer option over the sales inside the window. */
export async function offerPerformance(
  publisher_id: string,
  from: Date,
  to: Date,
): Promise<PerformanceRow[]> {
  return perOption(await unitMoney((await app()).db, publisher_id, { from, to }));
}

export interface PerformanceView extends OptionFigures {
  title: string;
}

/** The last 30 days per offer option with the article title, for the Offers page. */
export async function readSellerPerformance(
  actor: Actor | null,
): Promise<PerformanceView[] | null> {
  const seller = sellerOf(actor);
  if (seller === null) return null;
  const a = await app();
  const w = sellerWindows(a.security.clock.now());
  const rows = await offerPerformance(seller.publisher_id, w.month.from, w.month.to);
  const titles = await titlesOf(
    a.db,
    seller.publisher_id,
    rows.map((r) => r.offer_id),
  );
  return rows.map((r) => ({ ...r, title: titles.get(r.offer_id) ?? r.offer_id }));
}

// ---------- SEL.3 Home ----------

/** This week's figures for the block with the most units (currency and stored environment). */
function weekOf(rows: readonly UnitMoney[]): WeekFigures | null {
  const groups = new Map<string, UnitMoney[]>();
  for (const r of rows) {
    const k = `${r.currency}\u0000${r.environment}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const best = [...groups.entries()].sort(
    ([ka, a], [kb, b]) => b.length - a.length || (ka < kb ? -1 : ka > kb ? 1 : 0),
  )[0];
  if (best === undefined) return null;
  const list = best[1];
  const first = list[0]!;
  const gross = list.reduce((x, r) => x + r.gross_minor, 0);
  const refunds = list.reduce((x, r) => x + r.refunds_minor, 0);
  const reversals = list.reduce((x, r) => x + r.reversals_minor, 0);
  return {
    currency: first.currency,
    environment: first.environment,
    units: list.length,
    gross_minor: gross,
    refunds_minor: refunds,
    reversals_minor: reversals,
    net_minor: gross - refunds - reversals,
  };
}

export async function readSellerHome(actor: Actor | null): Promise<SellerHomeRead | null> {
  const seller = sellerOf(actor);
  if (seller === null) return null;
  const a = await app();
  const w = sellerWindows(a.security.clock.now());
  const home = await a.engine.publisherHome(seller);
  if (home === null) return null;
  const week = weekOf(await unitMoney(a.db, seller.publisher_id, w.week));
  const pending = (await a.engine.publisherPending(seller)) ?? [];
  return {
    display_name: home.display_name,
    week,
    agent: await agentShare(seller.publisher_id, w.month.from, w.month.to),
    top: await topOffers(seller.publisher_id, w.month.from, w.month.to, 3),
    needs_you: pending.length,
  };
}

// ---------- SEL.4 the setup path ----------

export interface SellerSetupRead {
  steps: SetupStep[];
  done: boolean;
}

export async function readSellerSetup(actor: Actor | null): Promise<SellerSetupRead | null> {
  const seller = sellerOf(actor);
  if (seller === null) return null;
  const a = await app();
  const home = await a.engine.publisherHome(seller);
  if (home === null) return null;
  const agreement = await a.engine.publisherAgreement(seller);
  const offers = await a.engine.offers.list(seller);
  const steps = setupSteps({
    status: home.status,
    terms_accepted: agreement !== null,
    payee_last4: home.payee.last4,
    payee_verified: home.payee.verified_at !== null,
    offers_total: offers === null ? 0 : offers.offers.length,
  });
  return { steps, done: setupDone(steps) };
}

// ---------- SEL.5 Money ----------

export interface SellerMoneyRead {
  environment: Awaited<
    ReturnType<Awaited<ReturnType<typeof app>>['engine']['publisherStatement']>
  > extends infer S
    ? S extends { environment: infer E }
      ? E
      : never
    : never;
  blocks: (MoneyBlockRead & { settlement: string })[];
}

export async function readSellerMoney(actor: Actor | null): Promise<SellerMoneyRead | null> {
  const seller = sellerOf(actor);
  if (seller === null) return null;
  const statement = await (await app()).engine.publisherStatement(seller);
  if (statement === null) return null;
  return {
    environment: statement.environment,
    blocks: statement.blocks.map((b) => ({
      currency: b.currency,
      environment: b.environment,
      sales_minor: b.sales_minor,
      refunds_minor: b.refunds_minor,
      reversals_minor: b.reversals_minor,
      net_minor: b.net_minor,
      paypal_fee_minor: b.paypal_fee_minor,
      modelled: blockLabels(b).modelled,
      settlement: b.settlement.sentence,
    })),
  };
}

// ---------- SEL.6 offers ----------

export async function readSellerOffers(actor: Actor | null) {
  const seller = sellerOf(actor);
  return seller === null ? null : (await app()).engine.offers.list(seller);
}

export interface OfferSaleRow {
  unit_id: string;
  order_ref6: string;
  created_at: string;
  status: string;
  currency: string;
  net_minor: number;
}

/** The offer, its price history (newest first), its sales and its share of each unit's money. */
export async function readSellerOffer(actor: Actor | null, offer_id: string) {
  const seller = sellerOf(actor);
  if (seller === null) return null;
  const a = await app();
  const offer = await a.engine.offers.get(seller, offer_id);
  if (offer === null) return null;
  const rows = await unitMoney(a.db, seller.publisher_id, null, true);
  const mine = rows.filter((r) => r.offers.some((o) => o.offer_id === offer_id));
  const meta = new Map<string, { order_ref6: string; created_at: string; status: string }>();
  if (mine.length > 0) {
    const m = await a.db.query<{
      unit_id: string;
      order_ref6: string;
      created_at: string;
      unit_status: string;
    }>(
      `SELECT unit_id, order_ref6, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, unit_status
         FROM txn_rows WHERE publisher_id = $1 AND unit_id = ANY($2::text[])`,
      [seller.publisher_id, mine.map((r) => r.unit_id)],
    );
    for (const x of m.rows)
      meta.set(x.unit_id, {
        order_ref6: x.order_ref6,
        created_at: x.created_at,
        status: x.unit_status,
      });
  }
  const sales: OfferSaleRow[] = mine
    .map((r) => {
      const x = meta.get(r.unit_id)!;
      return {
        unit_id: r.unit_id,
        order_ref6: x.order_ref6,
        created_at: x.created_at,
        status: statusText(x.status),
        currency: r.currency,
        net_minor: offerShare(r, offer_id).net_minor,
      };
    })
    .sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0));
  return { ...offer, sales };
}

export type { OfferFigures };
export { perOffer };
