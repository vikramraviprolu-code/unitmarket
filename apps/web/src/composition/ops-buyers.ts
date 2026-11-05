// INT-UI0 / UI0.7 and INT-OPS-A / OPS-A.5: the reads of the operator Buyers tab: the case queue and one case.
// The queue is AL's read through ops-home.ts. The case page adds one single-use Idempotency-Key per action (the
// browser cannot make one) and carries the text of the message to the buyer, which only an operator may read.
import type { Actor, TxnLine } from '@umsbx/contracts';
import { app, listTransactions } from '../server/access';
import { withOpsIdentity } from '../server/ops-identity';
import { OPS_MFA_NOTICE } from '../lib/ops-entity-view';
import { CAP_COLUMNS, KEY_COLUMNS, capRow, keyRow } from '../lib/ops-agents-view';
import type { CapRow, KeyRow, RawCap, RawKey } from '../lib/ops-agents-view';
import { readCaseDetail, readCaseQueue as readQueue } from './ops-home';
import { CASE_ACTION_KINDS } from '../lib/ops-cases-view';

export const readCaseQueue = readQueue;

export async function readCasePage(actor: Actor, id: string) {
  if (actor.kind !== 'operator') return null;
  const detail = await readCaseDetail(actor, id);
  if (detail === null) return null;
  const newKey = (await app()).engine.newKey;
  const keys: Record<string, string> = {};
  for (const kind of CASE_ACTION_KINDS) keys[kind] = newKey();
  return { detail, keys };
}

/** The injected clock, as the queue needs it to mark a case late. Empty for anyone but an operator. */
export async function readNow(actor: Actor): Promise<string> {
  const h = await (await app()).engine.opsHealth(actor);
  return h === null ? '' : h.now;
}

// INT-OPS-C / OPS-C.1: the buyer page. Identity by definition, so it needs the second factor: without it the read
// answers only the notice, whether or not the buyer exists. With it: the buyer, their orders (SR1's operator list
// filtered by buyer, through withOpsIdentity), the library count, refunds, caps and keys. Null for anyone who is not
// an operator and for an unknown buyer. No secret hash, no refund reason text.
export type BuyerPageRead =
  | { kind: 'mfa_required'; notice: string }
  | {
      kind: 'page';
      environment: Awaited<ReturnType<typeof app>>['environment'];
      buyer: { id: string; display_name: string; country: string; created_at: string };
      orders: TxnLine[];
      library_count: number;
      refunds: {
        id: string;
        order_ref: string;
        state: string;
        amount_minor: number | null;
        currency: string;
        updated_at: string;
      }[];
      caps: CapRow[];
      keys: KeyRow[];
    };

export async function readBuyerPage(actor: Actor, id: string): Promise<BuyerPageRead | null> {
  if (actor.kind !== 'operator') return null;
  if (actor.mfa !== true) return { kind: 'mfa_required', notice: OPS_MFA_NOTICE };
  const a = await app();
  const b = (
    await a.db.query<{
      id: string;
      display_name: string;
      country: string;
      created_at: string | Date;
    }>('SELECT id, display_name, country, created_at FROM buyers WHERE id = $1', [id])
  ).rows[0];
  if (b === undefined) return null;
  const now = a.security.clock.now();
  // The list matches the buyer by id alone (the opaque match), and the lines carry identity because this
  // session has the second factor.
  const listed = await listTransactions(
    a.db,
    { ...actor, mfa: false },
    { buyer: b.id, limit: '100' },
    { now },
  );
  const lib = await a.db.query<{ c: string | number }>(
    'SELECT count(*) AS c FROM entitlements WHERE buyer_id = $1',
    [b.id],
  );
  const refunds = await a.db.query<{
    id: string;
    order_ref: string;
    state: string;
    amount_minor: string | number | null;
    currency: string;
    updated_at: string | Date;
  }>(
    `SELECT r.id, o.order_ref, r.state, r.amount_minor, r.currency, r.updated_at
       FROM refund_requests r JOIN order_units u ON u.id = r.unit_id JOIN orders o ON o.id = u.order_id
      WHERE o.buyer_id = $1 ORDER BY r.created_at DESC, r.id`,
    [b.id],
  );
  const caps = await a.db.query<RawCap>(
    `SELECT ${CAP_COLUMNS} FROM mandates WHERE buyer_id = $1 ORDER BY created_at DESC, id`,
    [b.id],
  );
  const keys = await a.db.query<RawKey>(
    `SELECT ${KEY_COLUMNS} FROM api_keys WHERE owner_kind = 'buyer' AND owner_id = $1 ORDER BY created_at, id`,
    [b.id],
  );
  const nowIso = now.toISOString();
  return {
    kind: 'page',
    environment: a.environment,
    buyer: {
      id: b.id,
      display_name: b.display_name,
      country: b.country,
      created_at: new Date(b.created_at).toISOString(),
    },
    orders: withOpsIdentity(actor, listed.rows, now),
    library_count: Number(lib.rows[0]?.c ?? 0),
    refunds: refunds.rows.map((r) => ({
      id: r.id,
      order_ref: r.order_ref,
      state: r.state,
      amount_minor: r.amount_minor === null ? null : Number(r.amount_minor),
      currency: r.currency,
      updated_at: new Date(r.updated_at).toISOString(),
    })),
    caps: caps.rows.map((c) => capRow(c, nowIso, true)),
    keys: keys.rows.map((k) => keyRow(k, true)),
  };
}
