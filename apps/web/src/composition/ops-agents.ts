// INT-UI0 / UI0.7 and INT-OPS-C / OPS-C.3: the composition module of the operator Agents and API tab. The read
// shows caps with spent and remaining, reservations, agent purchases, keys and webhook subscriptions with their last
// delivery, under the identity rule (C2): without the second factor no buyer id, and key ids as their last four.
// Every read names its columns. A webhook URL is cut to its host here, inside the read, so its path and query never
// reach the page (C1, N-C3); the signing secret and a key's secret hash are never selected.
// The two writes are the operator revokes (C3, C4); the routes import them from here (C7).
// INT-CTL (CTL.7) adds the API exposure rows. They come from the api_exposure table, never from the journal, and
// only an operator gets them.
import type { Actor } from '@umsbx/contracts';
import { revokeKeyAsOperator } from '@umsbx/security';
import { apiKeyDeps, app, createApiV1, revokeMandateAsOperator } from '../server/access';
import {
  CAP_COLUMNS,
  KEY_COLUMNS,
  capRow,
  keyRow,
  keyShown,
  webhookHost,
} from '../lib/ops-agents-view';
import type { CapRow, KeyRow, RawCap, RawKey, RevokeReason } from '../lib/ops-agents-view';
import type { ExposureRow } from '../server/access';

export async function readExposure(actor: Actor): Promise<ExposureRow[] | null> {
  return (await app()).engine.readApiExposure(actor);
}

/** The most rows each list of the page shows, newest first. */
export const AGENTS_LIST_CAP = 200;

export interface OpsAgentsRead {
  environment: Awaited<ReturnType<typeof app>>['environment'];
  mfa: boolean;
  now: string;
  caps: CapRow[];
  reservations: {
    id: string;
    mandate_id: string;
    amount_minor: number;
    currency: string;
    state: string;
    created_at: string;
  }[];
  purchases: { agent_key: string; state: string; created_at: string }[];
  keys: KeyRow[];
  webhooks: {
    id: string;
    owner_kind: string;
    host: string | null;
    event_types: string[];
    created_at: string;
    disabled_at: string | null;
    last_status: string | null;
    last_error: string | null;
  }[];
  /** One single-use Idempotency-Key per revoke form, by cap or key id; empty without the second factor. */
  revokeKeys: Record<string, string>;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const isoOrNull = (v: string | Date | null): string | null => (v === null ? null : iso(v));

export async function readOpsAgents(actor: Actor): Promise<OpsAgentsRead | null> {
  if (actor.kind !== 'operator') return null;
  const mfa = actor.mfa === true;
  const a = await app();
  const now = a.security.clock.now().toISOString();
  const caps = await a.db.query<RawCap>(
    `SELECT ${CAP_COLUMNS} FROM mandates ORDER BY created_at DESC, id LIMIT $1`,
    [AGENTS_LIST_CAP],
  );
  const res = await a.db.query<{
    id: string;
    mandate_id: string;
    amount_minor: string | number;
    currency: string;
    state: string;
    created_at: string | Date;
  }>(
    `SELECT r.id, r.mandate_id, r.amount_minor, m.currency, r.state, r.created_at
       FROM mandate_reservations r JOIN mandates m ON m.id = r.mandate_id
      ORDER BY r.created_at DESC, r.id LIMIT $1`,
    [AGENTS_LIST_CAP],
  );
  const purchases = await a.db.query<{
    agent_key_id: string;
    state: string;
    created_at: string | Date;
  }>(
    `SELECT agent_key_id, state, created_at FROM agent_purchases
      ORDER BY created_at DESC, agent_key_id, idempotency_key LIMIT $1`,
    [AGENTS_LIST_CAP],
  );
  const keys = await a.db.query<RawKey>(
    `SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at DESC, id LIMIT $1`,
    [AGENTS_LIST_CAP],
  );
  const hooks = await a.db.query<{
    id: string;
    owner_kind: string;
    url: string;
    event_types: string[];
    created_at: string | Date;
    disabled_at: string | Date | null;
    last_status: string | null;
    last_error: string | null;
  }>(
    `SELECT s.id, s.owner_kind, s.url, s.event_types, s.created_at, s.disabled_at,
            d.status AS last_status, d.last_error
       FROM webhook_subscriptions s
       LEFT JOIN LATERAL (
         SELECT status, last_error FROM webhook_deliveries
          WHERE subscription_id = s.id ORDER BY updated_at DESC, id DESC LIMIT 1
       ) d ON true
      ORDER BY s.created_at DESC, s.id LIMIT $1`,
    [AGENTS_LIST_CAP],
  );
  const revokeKeys: Record<string, string> = {};
  if (mfa) {
    for (const c of caps.rows) if (c.revoked_at === null) revokeKeys[c.id] = a.engine.newKey();
    for (const k of keys.rows) if (k.revoked_at === null) revokeKeys[k.id] = a.engine.newKey();
  }
  return {
    environment: a.environment,
    mfa,
    now,
    caps: caps.rows.map((c) => capRow(c, now, mfa)),
    reservations: res.rows.map((r) => ({
      id: r.id,
      mandate_id: r.mandate_id,
      amount_minor: Number(r.amount_minor),
      currency: r.currency,
      state: r.state,
      created_at: iso(r.created_at),
    })),
    purchases: purchases.rows.map((p) => ({
      agent_key: keyShown(p.agent_key_id, mfa),
      state: p.state,
      created_at: iso(p.created_at),
    })),
    keys: keys.rows.map((k) => keyRow(k, mfa)),
    // The URL stops here: only its host goes on.
    webhooks: hooks.rows.map((h) => ({
      id: h.id,
      owner_kind: h.owner_kind,
      host: webhookHost(h.url),
      event_types: [...h.event_types],
      created_at: iso(h.created_at),
      disabled_at: isoOrNull(h.disabled_at),
      last_status: h.last_status,
      last_error: h.last_error,
    })),
    revokeKeys,
  };
}

export type RevokeResult =
  | { ok: true; value: { id: string; revoked_at: string } }
  | { ok: false; error: 'not_found' | 'not_operator' | 'mfa_required' | 'invalid_reason' };

/** POST /api/ops/mandates/[id]/revoke: the operator ends any cap. */
export async function revokeCap(
  actor: Actor,
  input: { id: string; reason_code: RevokeReason },
): Promise<RevokeResult> {
  const a = await app();
  const r = await revokeMandateAsOperator(
    a.db,
    {
      clock: a.security.clock,
      ids: a.security.ids,
      outbox: createApiV1(a).events,
      audit: a.security.audit,
    },
    actor,
    input,
  );
  if (!r.ok) return r;
  return { ok: true, value: { id: r.value.id, revoked_at: r.value.revoked_at ?? '' } };
}

/** POST /api/ops/api-keys/[id]/revoke: the operator revokes any key. */
export async function revokeApiKey(
  actor: Actor,
  input: { id: string; reason_code: RevokeReason },
): Promise<RevokeResult> {
  const a = await app();
  const r = await revokeKeyAsOperator(apiKeyDeps(a), actor, input.id, input.reason_code);
  if (!r.ok) return r;
  return { ok: true, value: { id: r.value.id, revoked_at: r.value.revoked_at ?? '' } };
}
