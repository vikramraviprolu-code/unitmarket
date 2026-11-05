// INT-AL / AL.6: what waits on an operator, as rows of kind, one sentence, a link and a count. Four sources: open
// alerts by severity, applicants with no decision, payee checks with no decision, and agent caps near the limit.
// A rejected applicant keeps status `applied` and has a decision row, so it is not counted (R2-3). Each link is a
// page of the operator shell (OPS_PAGES). Counts only: no name, no id, no money.
import type { OpsPage, SqlExecutor } from '@umsbx/contracts';
import { ALERT_KINDS, severityOf } from './catalogue';
import type { Severity } from './catalogue';
import { NOT_RESOLVED } from './state';

export type NeedsYouKind =
  'open_alerts' | 'applicants_waiting' | 'payee_checks_waiting' | 'caps_near_limit';
export interface NeedsYouRow {
  kind: NeedsYouKind;
  sentence: string;
  href: string;
  count: number;
}

const ORDER: Severity[] = ['critical', 'high', 'medium', 'info'];
const page = (p: OpsPage, anchor?: string): string => (anchor === undefined ? p : `${p}#${anchor}`);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function needsYou(db: Pick<SqlExecutor, 'query'>): Promise<NeedsYouRow[]> {
  const rows: NeedsYouRow[] = [];

  const byKind = await db.query<{ kind: string; c: string | number }>(
    `SELECT a.kind, count(*) AS c FROM alerts a WHERE ${NOT_RESOLVED} GROUP BY a.kind`,
  );
  const bySeverity = new Map<Severity, number>();
  let caps = 0;
  for (const r of byKind.rows) {
    const n = Number(r.c);
    const sev = (ALERT_KINDS as readonly string[]).includes(r.kind) ? severityOf(r.kind)! : 'info';
    bySeverity.set(sev, (bySeverity.get(sev) ?? 0) + n);
    if (r.kind === 'mandate_near_cap') caps += n;
  }
  for (const sev of ORDER) {
    const n = bySeverity.get(sev) ?? 0;
    if (n > 0) {
      rows.push({
        kind: 'open_alerts',
        sentence: `${plural(n, `${sev} alert is`, `${sev} alerts are`)} waiting for you.`,
        href: page('/ops', 'ops-alerts'),
        count: n,
      });
    }
  }

  const applicants = await db.query<{ c: string | number }>(
    `SELECT count(*) AS c FROM publishers p
      WHERE p.status = 'applied'
        AND NOT EXISTS (SELECT 1 FROM publisher_applicant_decisions d WHERE d.publisher_id = p.id)`,
  );
  const a = Number(applicants.rows[0]?.c ?? 0);
  if (a > 0) {
    rows.push({
      kind: 'applicants_waiting',
      sentence: `${plural(a, 'seller application is', 'seller applications are')} waiting for a decision.`,
      href: page('/ops/publishers'),
      count: a,
    });
  }

  const payees = await db.query<{ c: string | number }>(
    `SELECT count(*) AS c FROM payee_change_requests r
      WHERE NOT EXISTS (SELECT 1 FROM payee_decisions d WHERE d.request_id = r.id)`,
  );
  const p = Number(payees.rows[0]?.c ?? 0);
  if (p > 0) {
    rows.push({
      kind: 'payee_checks_waiting',
      sentence: `${plural(p, 'payee change is', 'payee changes are')} waiting for a check.`,
      href: page('/ops/payee-requests'),
      count: p,
    });
  }

  if (caps > 0) {
    rows.push({
      kind: 'caps_near_limit',
      sentence: `${plural(caps, 'agent cap is', 'agent caps are')} near the limit.`,
      href: page('/ops', 'ops-alerts'),
      count: caps,
    });
  }
  return rows;
}
