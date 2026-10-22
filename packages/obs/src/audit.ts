import { redact, redactString } from './redact';
import type { Actor, AuditEntry, AuditSink, Clock, Ids } from '@umsbx/contracts';

function actorColumns(actor: Actor): {
  kind: string;
  id: string | null;
  extra: Record<string, boolean>;
} {
  switch (actor.kind) {
    case 'buyer':
      return { kind: 'buyer', id: actor.buyer_id, extra: {} };
    case 'publisher':
      return { kind: 'publisher', id: actor.publisher_id, extra: {} };
    case 'operator':
      return { kind: 'operator', id: actor.operator_id, extra: { actor_mfa: actor.mfa } };
    case 'system':
      return { kind: 'system', id: null, extra: {} };
  }
}

// Inserts one row into audit_log through the caller's transaction, so the record commits or rolls
// back together with the action it describes. Id and time come from the injected ports.
export function createAuditSink(ids: Ids, clock: Clock): AuditSink {
  return {
    async record(tx, e: AuditEntry): Promise<void> {
      const a = actorColumns(e.actor);
      const detail = redact({ ...e.detail, ...a.extra });
      await tx.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [
          ids.next('aud'),
          a.kind,
          a.id,
          redactString(e.action),
          e.target,
          e.reason === null ? null : redactString(e.reason),
          JSON.stringify(detail),
          clock.now().toISOString(),
        ],
      );
    },
  };
}
