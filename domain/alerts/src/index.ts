export const PACKAGE_NAME = '@umsbx/alerts' as const;

export { ALERT_KINDS, describeAlert, describeGate, kindsOf, severityOf } from './catalogue';
export type { AlertDescription, CatalogueKind, Fix, MoneyRule, Severity } from './catalogue';
export { acknowledgeAlert, alertState, reopenAlert, resolveAlert } from './state';
export type { AlertState, AlertStateView, ResolveReasonCode, StateDeps, StateError } from './state';
export { getAlert, listAlerts } from './read';
export type {
  AlertDetail,
  AlertHistoryEntry,
  AlertList,
  AlertQuery,
  AlertRow,
  MoneyAtRisk,
} from './read';
export { autoResolve } from './autoresolve';
export { raiseSignals } from './signals';
export type { SignalCounts } from './signals';
export { needsYou } from './needs-you';
export type { NeedsYouKind, NeedsYouRow } from './needs-you';

import type { CoreDeps } from '@umsbx/contracts';
import { autoResolve } from './autoresolve';
import { raiseSignals } from './signals';

/** One step of the job loop: raise the two signals, then resolve what has cleared. */
export async function sweepAlerts(
  d: Pick<CoreDeps, 'db' | 'clock' | 'ids'>,
): Promise<{ raised: number; reopened: number; resolved: number }> {
  const s = await raiseSignals(d);
  const r = await autoResolve(d);
  return { ...s, resolved: r.resolved };
}
