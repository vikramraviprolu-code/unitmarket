// API-C (E2): the webhook delivery pass. One pass does two things, each bounded by max_items:
//  1. Fan-out: for each outbox event not yet marked in webhook_fanout (oldest first), write one delivery per
//     matching subscription and mark the event. Matching = the subscription is enabled, asked for the type,
//     was made at or before the event, and the event is about its owner (eventAudience; a buyer's
//     refund.completed is matched through the order). UNIQUE (event, subscription) makes a replay harmless.
//  2. Send: for each delivery that is due (oldest first), claim it with a compare-and-set that counts the
//     attempt and moves next_at to the end of a lease, sign the body and give it to the WebhookSender.
//     Success ends it. A failure waits RETRY_DELAYS_MS[attempt - 1] and tries again; the sixth failure
//     ends it dead. A delivery whose subscription was disabled ends dead without a send. A row that
//     already used its last attempt and is due again (a crash after the claim) ends dead, never a seventh.
// The pass sends nothing itself: the sender is a port (MVP 1: an in-process sink), and the signature is
// made by the injected `sign`, because jobs may not import the web app. Secrets, bodies, urls and the
// words of an error are never logged or stored; a failure is a code from a closed list.
import {
  eventAudience,
  type Clock,
  type Database,
  type EventType,
  type Ids,
  type Logger,
  type WebhookSender,
  type WebhookSendError,
} from '@umsbx/contracts';

/** Wait after the failed attempt n (1 to 5) before attempt n + 1. */
export const RETRY_DELAYS_MS: readonly number[] = [
  60_000, 300_000, 1_800_000, 7_200_000, 21_600_000,
];
/** Sends in all, the first included. */
export const MAX_ATTEMPTS = 6;
/** How long a claimed delivery stays claimed; a pass that dies leaves it due again after this. */
export const LEASE_MS = 300_000;

export interface DeliverDeps {
  db: Database;
  clock: Clock;
  ids: Ids;
  log: Logger;
  sender: WebhookSender;
  /** The value of the signature header for `body` at unix time `t`. */
  sign(secret: string, t: number, body: string): string;
}
export interface DeliverCounts {
  fanned_out: number;
  attempted: number;
  delivered: number;
  failed: number;
  dead: number;
}

const iso = (v: unknown): string => new Date(v as string | Date).toISOString();

interface EventRow {
  id: string;
  type: EventType;
  payload: unknown;
  occurred_at: string | Date;
}
interface SubRow {
  id: string;
  owner_kind: 'buyer' | 'publisher' | 'operator';
  owner_id: string;
}

async function fanOut(d: DeliverDeps, max_items: number): Promise<number> {
  const events = await d.db.query<EventRow>(
    `SELECT e.id, e.type, e.payload, e.occurred_at FROM event_outbox e
      WHERE NOT EXISTS (SELECT 1 FROM webhook_fanout f WHERE f.event_id = e.id)
      ORDER BY e.occurred_at, e.id LIMIT $1`,
    [max_items],
  );
  for (const e of events.rows) {
    await d.db.transaction(async (tx) => {
      const subs = await tx.query<SubRow>(
        `SELECT id, owner_kind, owner_id FROM webhook_subscriptions
          WHERE disabled_at IS NULL AND $1 = ANY (event_types) AND created_at <= $2::timestamptz
          ORDER BY created_at, id`,
        [e.type, iso(e.occurred_at)],
      );
      const about = eventAudience(e.type, e.payload);
      let buyer = about.buyer_id;
      if (buyer === null && about.order_id !== null && e.type === 'refund.completed') {
        const o = await tx.query<{ buyer_id: string }>(
          'SELECT buyer_id FROM orders WHERE id = $1',
          [about.order_id],
        );
        buyer = o.rows[0]?.buyer_id ?? null;
      }
      const now = d.clock.now().toISOString();
      for (const s of subs.rows) {
        const mine =
          s.owner_kind === 'buyer'
            ? buyer === s.owner_id
            : s.owner_kind === 'publisher'
              ? about.publisher_id === s.owner_id
              : about.operators;
        if (!mine) continue;
        await tx.query(
          `INSERT INTO webhook_deliveries
             (id, event_id, subscription_id, attempt, status, next_at, last_error, created_at, updated_at)
           VALUES ($1, $2, $3, 0, 'pending', $4::timestamptz, NULL, $4::timestamptz, $4::timestamptz)
           ON CONFLICT (event_id, subscription_id) DO NOTHING`,
          [d.ids.next('wdl'), e.id, s.id, now],
        );
      }
      await tx.query(
        `INSERT INTO webhook_fanout (event_id, created_at, updated_at)
         VALUES ($1, $2::timestamptz, $2::timestamptz) ON CONFLICT (event_id) DO NOTHING`,
        [e.id, now],
      );
    });
  }
  return events.rows.length;
}

interface DueRow {
  id: string;
  event_id: string;
  attempt: number | string;
  type: EventType;
  payload: unknown;
  occurred_at: string | Date;
  url: string;
  signing_secret: string;
  disabled_at: string | Date | null;
}

/** Ends a delivery without a send, unless another pass changed it first. */
async function bury(
  d: DeliverDeps,
  row: DueRow,
  attempt: number,
  last_error: string | null,
): Promise<boolean> {
  const now = d.clock.now().toISOString();
  const done = await d.db.query(
    `UPDATE webhook_deliveries
        SET status = 'dead', next_at = NULL, last_error = COALESCE($3, last_error), updated_at = $4::timestamptz
      WHERE id = $1 AND attempt = $2 AND status IN ('pending', 'failed')
      RETURNING id`,
    [row.id, attempt, last_error, now],
  );
  return done.rows.length === 1;
}

async function send(d: DeliverDeps, counts: DeliverCounts, max_items: number): Promise<void> {
  const due = await d.db.query<DueRow>(
    `SELECT w.id, w.event_id, w.attempt, e.type, e.payload, e.occurred_at, s.url, s.signing_secret, s.disabled_at
       FROM webhook_deliveries w
       JOIN event_outbox e ON e.id = w.event_id
       JOIN webhook_subscriptions s ON s.id = w.subscription_id
      WHERE w.status IN ('pending', 'failed') AND w.next_at <= $1::timestamptz
      ORDER BY w.next_at, e.occurred_at, e.id, w.id LIMIT $2`,
    [d.clock.now().toISOString(), max_items],
  );
  for (const row of due.rows) {
    const before = Number(row.attempt);
    if (before >= MAX_ATTEMPTS) {
      if (await bury(d, row, before, null)) counts.dead += 1;
      continue;
    }
    if (row.disabled_at !== null) {
      if (await bury(d, row, before, 'subscription_disabled')) counts.dead += 1;
      continue;
    }
    const attempt = before + 1;
    const start = d.clock.now();
    const claimed = await d.db.query(
      `UPDATE webhook_deliveries SET attempt = $2, next_at = $3::timestamptz, updated_at = $4::timestamptz
        WHERE id = $1 AND attempt = $5 AND status IN ('pending', 'failed') AND next_at <= $4::timestamptz
        RETURNING id`,
      [
        row.id,
        attempt,
        new Date(start.getTime() + LEASE_MS).toISOString(),
        start.toISOString(),
        before,
      ],
    );
    if (claimed.rows.length === 0) continue;

    counts.attempted += 1;
    const body = JSON.stringify({
      id: row.event_id,
      type: row.type,
      payload: row.payload,
      occurred_at: iso(row.occurred_at),
    });
    let error: WebhookSendError | 'sender_error' | null;
    try {
      const out = await d.sender.send({
        url: row.url,
        headers: {
          'Content-Type': 'application/json',
          'UnitMarket-Event-Id': row.event_id,
          'UnitMarket-Signature': d.sign(
            row.signing_secret,
            Math.floor(start.getTime() / 1000),
            body,
          ),
        },
        body,
      });
      error = out.ok ? null : out.error;
    } catch {
      error = 'sender_error';
    }

    const now = d.clock.now();
    if (error === null) {
      await d.db.query(
        `UPDATE webhook_deliveries SET status = 'delivered', next_at = NULL, last_error = NULL, updated_at = $3::timestamptz
          WHERE id = $1 AND attempt = $2`,
        [row.id, attempt, now.toISOString()],
      );
      counts.delivered += 1;
      continue;
    }
    const last = attempt >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE webhook_deliveries SET status = $3, next_at = $4::timestamptz, last_error = $5, updated_at = $6::timestamptz
        WHERE id = $1 AND attempt = $2`,
      [
        row.id,
        attempt,
        last ? 'dead' : 'failed',
        last ? null : new Date(now.getTime() + (RETRY_DELAYS_MS[attempt - 1] ?? 0)).toISOString(),
        error,
        now.toISOString(),
      ],
    );
    if (last) counts.dead += 1;
    else counts.failed += 1;
    d.log.log({
      msg: last ? 'jobs.deliver.dead' : 'jobs.deliver.failed',
      level: 'warn',
      fields: { delivery_id: row.id, attempt, error },
    });
  }
}

export async function runDeliveryPass(
  d: DeliverDeps,
  o: { max_items: number },
): Promise<DeliverCounts> {
  const counts: DeliverCounts = { fanned_out: 0, attempted: 0, delivered: 0, failed: 0, dead: 0 };
  if (o.max_items <= 0) return counts;
  counts.fanned_out = await fanOut(d, o.max_items);
  await send(d, counts, o.max_items);
  return counts;
}
