// INT-AL / AL.3: the state of an alert is its latest alert_events row, or `open` when there is none. Every change
// is an append: acknowledged, resolved (with a reason code from a closed list and an optional note kept only as
// a sha256), auto_resolved (the sweep) and reopened. Who and when come from the journal of INT-TR0: the row is a
// tracked table, so the capture trigger writes the actor and the channel of the request or the job pass.
import { createHash } from 'node:crypto';
import { RESOLVE_NOTE_MAX, RESOLVE_REASON_CODES, err, ok } from '@umsbx/contracts';
import type { CoreDeps, Result, SqlExecutor } from '@umsbx/contracts';

export type AlertState = 'open' | 'acknowledged' | 'resolved';
export type ResolveReasonCode = (typeof RESOLVE_REASON_CODES)[number];
export type EventKind = 'acknowledged' | 'resolved' | 'auto_resolved' | 'reopened';
export type StateError = { code: 'not_found' | 'wrong_state' | 'bad_input' };
export interface AlertStateView {
  alert_id: string;
  state: AlertState;
}
export type StateDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids'>;

/** SQL: the kind of the latest event of alert `a` (null when it has none). */
export const LAST_EVENT = `(SELECT e.kind FROM alert_events e WHERE e.alert_id = a.id ORDER BY e.seq DESC LIMIT 1)`;
/** SQL: true when alert `a` is open or only acknowledged. */
export const NOT_RESOLVED = `COALESCE(${LAST_EVENT}, 'open') NOT IN ('resolved', 'auto_resolved')`;

export const stateOfKind = (last: string | null): AlertState =>
  last === 'acknowledged'
    ? 'acknowledged'
    : last === 'resolved' || last === 'auto_resolved'
      ? 'resolved'
      : 'open';

export async function alertState(
  db: Pick<SqlExecutor, 'query'>,
  alert_id: string,
): Promise<AlertState | null> {
  const r = await db.query<{ id: string; last: string | null }>(
    `SELECT a.id, ${LAST_EVENT} AS last FROM alerts a WHERE a.id = $1`,
    [alert_id],
  );
  const row = r.rows[0];
  return row === undefined ? null : stateOfKind(row.last);
}

export async function appendEvent(
  tx: Pick<SqlExecutor, 'query'>,
  d: Pick<CoreDeps, 'clock' | 'ids'>,
  i: {
    alert_id: string;
    kind: EventKind;
    reason_code?: string | null;
    note_sha256?: string | null;
  },
): Promise<void> {
  const at = d.clock.now().toISOString();
  await tx.query(
    `INSERT INTO alert_events (id, alert_id, kind, reason_code, note_sha256, at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
    [d.ids.next('ale'), i.alert_id, i.kind, i.reason_code ?? null, i.note_sha256 ?? null, at],
  );
}

type Change =
  | { kind: 'acknowledged' }
  | { kind: 'resolved'; reason_code: ResolveReasonCode; note: string | undefined }
  | { kind: 'reopened' };

async function change(
  d: StateDeps,
  alert_id: string,
  c: Change,
): Promise<Result<AlertStateView, StateError>> {
  return d.db.transaction(async (tx) => {
    // The alert row is the lock: two changes on one alert take their turns, so the answer follows the state.
    const found = await tx.query<{ id: string }>('SELECT id FROM alerts WHERE id = $1 FOR UPDATE', [
      alert_id,
    ]);
    if (found.rows.length === 0) return err({ code: 'not_found' });
    const now = (await alertState(tx, alert_id)) ?? 'open';
    const view = (state: AlertState): Result<AlertStateView, StateError> => ok({ alert_id, state });
    switch (c.kind) {
      case 'acknowledged':
        if (now === 'acknowledged') return view('acknowledged'); // a second acknowledge is a no-op
        if (now === 'resolved') return err({ code: 'wrong_state' });
        await appendEvent(tx, d, { alert_id, kind: 'acknowledged' });
        return view('acknowledged');
      case 'resolved':
        if (now === 'resolved') return view('resolved'); // a second resolve is a no-op, the first reason stands
        await appendEvent(tx, d, {
          alert_id,
          kind: 'resolved',
          reason_code: c.reason_code,
          note_sha256:
            c.note === undefined || c.note === ''
              ? null
              : createHash('sha256').update(c.note).digest('hex'),
        });
        return view('resolved');
      case 'reopened':
        if (now !== 'resolved') return err({ code: 'wrong_state' });
        await appendEvent(tx, d, { alert_id, kind: 'reopened' });
        return view('open');
    }
  });
}

export const acknowledgeAlert = (d: StateDeps, i: { alert_id: string }) =>
  change(d, i.alert_id, { kind: 'acknowledged' });

export function resolveAlert(
  d: StateDeps,
  i: { alert_id: string; reason_code: ResolveReasonCode; note?: string },
): Promise<Result<AlertStateView, StateError>> {
  const okCode = (RESOLVE_REASON_CODES as readonly string[]).includes(i.reason_code);
  if (!okCode || (i.note !== undefined && i.note.length > RESOLVE_NOTE_MAX)) {
    return Promise.resolve(err({ code: 'bad_input' }));
  }
  return change(d, i.alert_id, { kind: 'resolved', reason_code: i.reason_code, note: i.note });
}

export const reopenAlert = (d: StateDeps, i: { alert_id: string }) =>
  change(d, i.alert_id, { kind: 'reopened' });
