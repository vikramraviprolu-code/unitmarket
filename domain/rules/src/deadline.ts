// BR-4: the refund deadline, a pure function of the terms frozen in the sale's approval snapshot (BR-3).
//   start    = the access start (access_windows.started_at) when it is set, else the verified capture time
//              (order_units.captured_verified_at);
//   deadline = start + the frozen refund.request_window, in days;
//   the window is open strictly before the deadline, so at exactly the deadline it is closed.
// A version 1 snapshot (approved before BR-3) has no terms and so no deadline. A version 2 snapshot always
// has terms; one that lost them, or whose terms are outside their safe range, is "invalid" here and a caller
// refuses it: it is never read as "no deadline" (D-096). No clock, database or environment: times are ISO
// strings the caller read.
import { RULE_KEYS, ResolvedTermsSchema, isRuleValueInRange } from '@umsbx/contracts';
import type { ResolvedTerms } from '@umsbx/contracts';

const DAY_MS = 86_400_000;

export type SnapshotTermsRead =
  | { readonly kind: 'v1' }
  | { readonly kind: 'v2'; readonly terms: ResolvedTerms }
  | { readonly kind: 'invalid' };

const INVALID: SnapshotTermsRead = { kind: 'invalid' };

/**
 * Reads the terms out of a stored approval snapshot (an object, or the JSON text a driver may return for
 * jsonb). Only the version label and the terms are read: the content hash was checked when the approval was
 * used, and the row cannot change after that.
 */
export function readSnapshotTerms(snapshot: unknown): SnapshotTermsRead {
  let value = snapshot;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return INVALID;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return INVALID;
  const body = value as Record<string, unknown>;
  if (body['snapshot_version'] === '1') {
    return 'terms' in body ? INVALID : { kind: 'v1' };
  }
  if (body['snapshot_version'] !== '2') return INVALID;
  const parsed = ResolvedTermsSchema.safeParse(body['terms']);
  if (!parsed.success) return INVALID;
  const terms = parsed.data;
  for (const key of RULE_KEYS) {
    if (!isRuleValueInRange(key, terms.values[key])) return INVALID;
  }
  if (terms.values['access.window'] < terms.values['refund.request_window']) return INVALID;
  return { kind: 'v2', terms };
}

/** The ISO time the refund window closes, or null when the sale has no deadline (version 1). */
export function refundDeadline(i: {
  readonly terms: ResolvedTerms | null;
  readonly access_started_at: string | null;
  readonly captured_verified_at: string;
}): string | null {
  if (i.terms === null) return null;
  const start = new Date(i.access_started_at ?? i.captured_verified_at).getTime();
  return new Date(start + i.terms.values['refund.request_window'] * DAY_MS).toISOString();
}

/** True while `at` is strictly before the deadline; always true with no deadline. */
export function refundWindowOpen(deadline: string | null, at: string): boolean {
  if (deadline === null) return true;
  return new Date(at).getTime() < new Date(deadline).getTime();
}
