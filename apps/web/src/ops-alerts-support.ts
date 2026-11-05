// INT-AL test support (not a test, not imported by product code): one booted offline app on the A rig, with
// the sessions the alert and case routes are tried with, and raw seeds for alerts and cases.
import { call } from './support';
import type { Session } from './support';
import { bootA } from './api-v1/a-support';
import type { ARig, Handler } from './api-v1/a-support';

export type { ARig, Handler, Session };

export interface AlertRig {
  rig: ARig;
  /** An operator session with the second factor. */
  op: Session;
  /** An operator session without it (the unverified demo operator). */
  noMfa: Session;
  buyer: Session;
  seller: Session;
  /** A bearer key of an operator, scope ops:read. */
  opKey: string;
}

export async function bootAlertRig(): Promise<AlertRig> {
  const rig = await bootA();
  return {
    rig,
    op: await rig.session({ kind: 'operator', operator_id: 'opr_vikram', mfa: true }),
    noMfa: await rig.session({ kind: 'operator', operator_id: 'opr_demo', mfa: false }),
    buyer: await rig.session(rig.buyerA),
    seller: await rig.session(rig.harbour),
    opKey: await rig.key(rig.operator, ['ops:read']),
  };
}

let n = 0;
/** A fresh Idempotency-Key. */
export const key = (): string => `al-test-key-${String(++n).padStart(6, '0')}-xyz`;

/** POST to a session route with the headers a browser sends. */
export function post(
  handler: Handler,
  url: string,
  o: {
    session: Session | null;
    body?: unknown;
    idem?: string | null;
    csrf?: boolean;
    headers?: Record<string, string>;
    params?: Record<string, string>;
  },
): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.idem !== null) headers['idempotency-key'] = o.idem ?? key();
  return call(handler as never, {
    url,
    method: 'POST',
    body: o.body ?? {},
    session: o.session,
    headers,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
    ...(o.params === undefined ? {} : { params: o.params }),
  });
}

/** An alert row with no order (the entity is in the reason), or on the first order of the app. */
export async function seedAlert(
  rig: ARig,
  i: {
    id: string;
    kind: string;
    reason: string;
    order_id?: string | null;
    unit_id?: string | null;
  },
): Promise<void> {
  const at = '2026-11-05T10:00:00.000Z';
  await rig.app.db.query(
    `INSERT INTO alerts (id, kind, order_id, unit_id, detail, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
    [i.id, i.kind, i.order_id ?? null, i.unit_id ?? null, JSON.stringify({ reason: i.reason }), at],
  );
}

export async function rows<T = Record<string, unknown>>(
  rig: ARig,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await rig.app.db.query<T>(sql, params)).rows;
}
