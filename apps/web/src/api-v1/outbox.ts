// API-W0 (F1): the event outbox adapter. append(tx, event) checks the type and the payload against the
// contract and inserts into event_outbox in the caller's transaction, so an event commits or rolls back with
// the change it describes. Delivery of events is lane C and is not here. Errors name the problem and never
// echo a value.
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  type Clock,
  type EventOutbox,
  type Id,
  type Ids,
  type OutboxEvent,
  type SqlExecutor,
} from '@umsbx/contracts';

export function createEventOutbox(deps: { ids: Ids; clock: Clock }): EventOutbox {
  return {
    async append(tx: SqlExecutor, event: OutboxEvent): Promise<Id> {
      if (!(EVENT_TYPES as readonly string[]).includes(event.type)) {
        throw new Error('event type is not one of the known event types');
      }
      const parsed = EVENT_PAYLOAD_SCHEMAS[event.type].safeParse(event.payload);
      if (!parsed.success) {
        throw new Error(`event payload does not match the ${event.type} schema`);
      }
      const id = deps.ids.next('evt');
      await tx.query(
        `INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ($1, $2, $3::jsonb, $4)`,
        [id, event.type, JSON.stringify(parsed.data), deps.clock.now().toISOString()],
      );
      return id;
    },
  };
}
