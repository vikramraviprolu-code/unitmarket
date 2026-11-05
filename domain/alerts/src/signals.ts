// INT-AL / AL.5: two signals the sweep raises through raiseAlert, `mandate_near_cap` and `webhook_failing`.
// Each raises once per entity and again on recurrence. Finished entities raise nothing, so the signal sweep and
// the auto-resolve sweep never flap (R2-1): a mandate that is revoked, exhausted or expired, and a disabled
// subscription, are skipped.
//
//   mandate_near_cap   spent_minor * 10 >= max_total_minor * 9, or used_count * 10 >= max_count * 9 (integers).
//                      Reason cap90_<mandate id>. A resolved alert reopens when the mandate changed after it.
//   webhook_failing    the last 3 deliveries of one subscription, by (created_at, id), are all failed or dead.
//                      Reason webhook_failing_<subscription id>_<id of the first of those 3>. A failure run that
//                      an alert already covers raises nothing; a new run after a recovery is a new alert.
import { raiseAlert } from '@umsbx/payments';
import type { CoreDeps, SqlExecutor } from '@umsbx/contracts';
import { alertState } from './state';

type Deps = Pick<CoreDeps, 'db' | 'clock' | 'ids'>;
export interface SignalCounts {
  raised: number;
  reopened: number;
}

const RUN_LOOKBACK = 50;

interface Existing {
  id: string;
  reason: string;
  resolved_at: string | null;
}

/** Alerts of one kind whose reason starts with `prefix`, with the time of their latest resolve (if resolved now). */
async function existing(tx: SqlExecutor, kind: string, prefix: string): Promise<Existing[]> {
  const r = await tx.query<{ id: string; reason: string }>(
    `SELECT a.id, a.detail ->> 'reason' AS reason FROM alerts a
      WHERE a.kind = $1 AND starts_with(a.detail ->> 'reason', $2)`,
    [kind, prefix],
  );
  const out: Existing[] = [];
  for (const row of r.rows) {
    const state = await alertState(tx, row.id);
    let at: string | null = null;
    if (state === 'resolved') {
      const e = await tx.query<{ at: string | Date }>(
        'SELECT at FROM alert_events WHERE alert_id = $1 ORDER BY seq DESC LIMIT 1',
        [row.id],
      );
      at = e.rows[0] === undefined ? null : new Date(e.rows[0].at).toISOString();
    }
    out.push({ id: row.id, reason: row.reason, resolved_at: at });
  }
  return out;
}

async function mandateSignals(tx: SqlExecutor, d: Deps, counts: SignalCounts): Promise<void> {
  const now = d.clock.now().toISOString();
  const near = await tx.query<{ id: string; updated_at: string | Date }>(
    `SELECT id, updated_at FROM mandates
      WHERE revoked_at IS NULL AND exhausted_at IS NULL AND expires_at > $1::timestamptz
        AND ((max_total_minor IS NOT NULL AND spent_minor::bigint * 10 >= max_total_minor::bigint * 9)
          OR (max_count IS NOT NULL AND used_count::bigint * 10 >= max_count::bigint * 9))
      ORDER BY id`,
    [now],
  );
  for (const m of near.rows) {
    const reason = `cap90_${m.id}`;
    const [have] = await existing(tx, 'mandate_near_cap', reason);
    if (have !== undefined) {
      // Open or acknowledged: it already says it. Resolved: only a change of the mandate since then is a recurrence.
      if (
        have.resolved_at === null ||
        Date.parse(have.resolved_at) >= new Date(m.updated_at).getTime()
      )
        continue;
    }
    const kind = await raiseAlert(tx, d, {
      kind: 'mandate_near_cap',
      order_id: null,
      unit_id: null,
      reason,
      detail: { mandate_id: m.id },
    });
    if (kind !== null) {
      if (have === undefined) counts.raised += 1;
      else counts.reopened += 1;
    }
  }
}

async function webhookSignals(tx: SqlExecutor, d: Deps, counts: SignalCounts): Promise<void> {
  const rows = await tx.query<{
    sub: string;
    id: string;
    status: string;
    created_at: string | Date;
    rn: number | string;
  }>(
    `SELECT sub, id, status, created_at, rn FROM (
        SELECT w.subscription_id AS sub, w.id, w.status, w.created_at,
               row_number() OVER (PARTITION BY w.subscription_id ORDER BY w.created_at DESC, w.id DESC) AS rn
          FROM webhook_deliveries w
          JOIN webhook_subscriptions s ON s.id = w.subscription_id AND s.disabled_at IS NULL
      ) x WHERE rn <= $1 ORDER BY sub, rn`,
    [RUN_LOOKBACK],
  );
  const bySub = new Map<string, typeof rows.rows>();
  for (const r of rows.rows) bySub.set(r.sub, [...(bySub.get(r.sub) ?? []), r]);
  for (const [sub, list] of bySub) {
    const run: typeof list = [];
    for (const r of list) {
      if (r.status !== 'failed' && r.status !== 'dead') break;
      run.push(r);
    }
    if (run.length < 3) continue;
    const first = run[2]!; // the oldest of the last three
    const prefix = `webhook_failing_${sub}_`;
    const runIds = new Set(run.map((r) => r.id));
    const covering = (await existing(tx, 'webhook_failing', prefix)).find((e) =>
      runIds.has(e.reason.slice(prefix.length)),
    );
    if (covering !== undefined) {
      const latestFailure = new Date(run[0]!.created_at).getTime();
      if (covering.resolved_at === null || Date.parse(covering.resolved_at) >= latestFailure)
        continue;
      const k = await raiseAlert(tx, d, {
        kind: 'webhook_failing',
        order_id: null,
        unit_id: null,
        reason: covering.reason,
        detail: { subscription_id: sub },
      });
      if (k !== null) counts.reopened += 1;
      continue;
    }
    const k = await raiseAlert(tx, d, {
      kind: 'webhook_failing',
      order_id: null,
      unit_id: null,
      reason: `${prefix}${first.id}`,
      detail: { subscription_id: sub },
    });
    if (k !== null) counts.raised += 1;
  }
}

export async function raiseSignals(d: Deps): Promise<SignalCounts> {
  return d.db.transaction(async (tx) => {
    const counts: SignalCounts = { raised: 0, reopened: 0 };
    await mandateSignals(tx, d, counts);
    await webhookSignals(tx, d, counts);
    return counts;
  });
}
