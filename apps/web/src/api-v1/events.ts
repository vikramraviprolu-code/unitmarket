// API-C (E1, E2): the events service behind the webhook-subscription routes, and the in-process sink that
// stands in for the HTTP sender in MVP 1.
// The service makes, lists, disables and reads the deliveries of the subscriptions of ONE owner: every query
// carries the owner kind and id, so another owner's subscription is simply not found (same answer as a
// missing id). The signing secret is "whsec_" plus 32 bytes from the SecretSource (never the seeded Rng); it
// is stored as is, returned by create and by nothing else, and never logged or audited.
// The sink opens no socket: it records each request and answers ok unless a test scripted another outcome.
import {
  WEBHOOK_OWNER_EVENTS,
  WebhookSubscriptionCreateSchema,
  err,
  ok,
  type Actor,
  type Clock,
  type Database,
  type Ids,
  type Result,
  type SecretSource,
  type WebhookDeliveryView,
  type WebhookOutcome,
  type WebhookRequest,
  type WebhookSender,
  type WebhookSubscriptionCreated,
  type WebhookSubscriptionView,
} from '@umsbx/contracts';

export interface EventsDeps {
  db: Database;
  clock: Clock;
  ids: Ids;
  secrets: SecretSource;
}
export type EventsError = { code: 'event_type_not_allowed' | 'not_found' | 'invalid_input' };
export interface Page<T> {
  items: T[];
  next_cursor: null;
}
type R<T> = Promise<Result<T, EventsError>>;

export interface EventsService {
  create(actor: Actor, input: unknown): R<WebhookSubscriptionCreated>;
  list(actor: Actor): R<Page<WebhookSubscriptionView>>;
  remove(actor: Actor, id: string): R<WebhookSubscriptionView>;
  deliveries(actor: Actor, id: string): R<Page<WebhookDeliveryView>>;
}

/** The newest rows a list shows. */
export const LIST_LIMIT = 100;

type Owner = { kind: 'buyer' | 'publisher' | 'operator'; id: string };
function ownerOf(actor: Actor): Owner | null {
  switch (actor.kind) {
    case 'buyer':
      return { kind: 'buyer', id: actor.buyer_id };
    case 'publisher':
      return { kind: 'publisher', id: actor.publisher_id };
    case 'operator':
      return { kind: 'operator', id: actor.operator_id };
    default:
      return null;
  }
}

const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

interface SubRow {
  id: string;
  url: string;
  event_types: string[];
  created_at: string | Date;
  disabled_at: string | Date | null;
}
const view = (r: SubRow): WebhookSubscriptionView => ({
  id: r.id,
  url: r.url,
  event_types: r.event_types as WebhookSubscriptionView['event_types'],
  created_at: iso(r.created_at),
  disabled_at: isoOrNull(r.disabled_at),
});
const SUB_COLUMNS = 'id, url, event_types, created_at, disabled_at';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export function createEventsService(deps: EventsDeps): EventsService {
  const { db, clock, ids, secrets } = deps;
  return {
    async create(actor, input) {
      const parsed = WebhookSubscriptionCreateSchema.safeParse(input);
      if (!parsed.success) return err({ code: 'invalid_input' });
      const owner = ownerOf(actor);
      if (owner === null) return err({ code: 'event_type_not_allowed' });
      const allowed: readonly string[] = WEBHOOK_OWNER_EVENTS[owner.kind];
      if (!parsed.data.event_types.every((t) => allowed.includes(t))) {
        return err({ code: 'event_type_not_allowed' });
      }
      const signing_secret = `whsec_${hex(secrets.bytes(32))}`;
      const id = ids.next('wsb');
      const now = clock.now().toISOString();
      await db.query(
        `INSERT INTO webhook_subscriptions
           (id, owner_kind, owner_id, url, event_types, signing_secret, created_at, updated_at, disabled_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $7, NULL)`,
        [id, owner.kind, owner.id, parsed.data.url, parsed.data.event_types, signing_secret, now],
      );
      return ok({
        id,
        url: parsed.data.url,
        event_types: parsed.data.event_types,
        created_at: now,
        disabled_at: null,
        signing_secret,
      });
    },

    async list(actor) {
      const owner = ownerOf(actor);
      if (owner === null) return ok({ items: [], next_cursor: null });
      const rows = await db.query<SubRow>(
        `SELECT ${SUB_COLUMNS} FROM webhook_subscriptions
          WHERE owner_kind = $1 AND owner_id = $2
          ORDER BY created_at DESC, id DESC LIMIT $3`,
        [owner.kind, owner.id, LIST_LIMIT],
      );
      return ok({ items: rows.rows.map(view), next_cursor: null });
    },

    async remove(actor, id) {
      const owner = ownerOf(actor);
      if (owner === null) return err({ code: 'not_found' });
      const now = clock.now().toISOString();
      const rows = await db.query<SubRow>(
        `UPDATE webhook_subscriptions
            SET disabled_at = COALESCE(disabled_at, $4::timestamptz),
                updated_at = CASE WHEN disabled_at IS NULL THEN $4::timestamptz ELSE updated_at END
          WHERE id = $1 AND owner_kind = $2 AND owner_id = $3
          RETURNING ${SUB_COLUMNS}`,
        [id, owner.kind, owner.id, now],
      );
      const row = rows.rows[0];
      return row === undefined ? err({ code: 'not_found' }) : ok(view(row));
    },

    async deliveries(actor, id) {
      const owner = ownerOf(actor);
      if (owner === null) return err({ code: 'not_found' });
      const mine = await db.query<{ id: string }>(
        `SELECT id FROM webhook_subscriptions WHERE id = $1 AND owner_kind = $2 AND owner_id = $3`,
        [id, owner.kind, owner.id],
      );
      if (mine.rows.length === 0) return err({ code: 'not_found' });
      const rows = await db.query<{
        id: string;
        event_id: string;
        event_type: string;
        attempt: number | string;
        status: string;
        next_at: string | Date | null;
        last_error: string | null;
        created_at: string | Date;
        updated_at: string | Date;
      }>(
        `SELECT d.id, d.event_id, e.type AS event_type, d.attempt, d.status, d.next_at, d.last_error,
                d.created_at, d.updated_at
           FROM webhook_deliveries d JOIN event_outbox e ON e.id = d.event_id
          WHERE d.subscription_id = $1
          ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
        [id, LIST_LIMIT],
      );
      return ok({
        items: rows.rows.map((r): WebhookDeliveryView => ({
          id: r.id,
          event_id: r.event_id,
          event_type: r.event_type as WebhookDeliveryView['event_type'],
          attempt: Number(r.attempt),
          status: r.status as WebhookDeliveryView['status'],
          next_at: isoOrNull(r.next_at),
          last_error: r.last_error as WebhookDeliveryView['last_error'],
          created_at: iso(r.created_at),
          updated_at: iso(r.updated_at),
        })),
        next_cursor: null,
      });
    },
  };
}

export interface InProcessSink extends WebhookSender {
  /** Every request given to `send`, in order, as it was given (a copy). */
  readonly records: readonly WebhookRequest[];
  /** The next sends answer these outcomes, one each, in order; after that every send answers ok. */
  script(...outcomes: WebhookOutcome[]): void;
  /** Forget the records and any scripted outcome. */
  clear(): void;
}

/** The MVP 1 WebhookSender: nothing leaves the process. */
export function createInProcessSink(): InProcessSink {
  let records: WebhookRequest[] = [];
  let scripted: WebhookOutcome[] = [];
  return {
    get records() {
      return records;
    },
    send(request) {
      records.push({ url: request.url, headers: { ...request.headers }, body: request.body });
      return Promise.resolve(scripted.shift() ?? { ok: true });
    },
    script(...outcomes) {
      scripted = [...scripted, ...outcomes];
    },
    clear() {
      records = [];
      scripted = [];
    },
  };
}
