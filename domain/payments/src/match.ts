// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/match.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// The pure read-back match (P5, RB-4). Compares a read of the PayPal order with the expected
// transaction written before the charge and with the claims stored from the capture call. It never
// reads a fee, and the expected side is never rebuilt from the read.
// Changes from the simulation: statuses are PayPal's six capture statuses (no REVERSED);
// REFUNDED is a match only for a capture we already verified; the order reference is the
// custom_id of the order; amounts are minor units.
import type {
  CaptureStatus,
  ClaimUnit,
  ExpectedTransaction,
  MatchField,
  MatchResult,
  OrderRead,
  ProviderOrderId,
  UnitMatch,
} from '@umsbx/contracts';

export interface MatchInput {
  expected: ExpectedTransaction;
  read: Extract<OrderRead, { kind: 'order' }>;
  /** The provider order id stored for this order; never one taken from a URL (P6). */
  provider_order_id: ProviderOrderId;
  /**
   * The stored claim of each unit. `claimed_at` is the time the claim (or the last read that
   * changed the unit while it was unverified) was stored; null for a verified unit, whose
   * capture_id is then the verified one.
   */
  claims: (ClaimUnit & { claimed_at: string | null })[];
  foreign_capture_ids: string[];
}

const byReferenceId = (a: { reference_id: string }, b: { reference_id: string }): number =>
  a.reference_id < b.reference_id ? -1 : a.reference_id > b.reference_id ? 1 : 0;

const orderFailure = (field: MatchField): MatchResult => ({ level: 'order', ok: false, field });

// COMPLETED and PARTIALLY_REFUNDED mean the money was received. REFUNDED also does, but only for a
// capture that was verified before (see below).
const RECEIVED = new Set<CaptureStatus>(['COMPLETED', 'PARTIALLY_REFUNDED']);

export function matchReadback(input: MatchInput): MatchResult {
  const { expected, read } = input;

  // Order level: the first failure is returned.
  if (read.provider_order_id !== input.provider_order_id) {
    return orderFailure('provider_order_id');
  }
  if (read.custom_id !== expected.order_ref) return orderFailure('reference');
  if (read.units.some((u) => u.amount.currency !== expected.currency)) {
    return orderFailure('currency');
  }
  const expectedIds = new Set(expected.units.map((u) => u.reference_id));
  if (read.units.some((u) => !expectedIds.has(u.reference_id))) {
    return orderFailure(read.units.length > expected.units.length ? 'extra_unit' : 'reference_id');
  }
  // Every id is expected, so a longer list repeats an id.
  if (read.units.length > expected.units.length) return orderFailure('extra_unit');
  const present = new Set(read.units.map((u) => u.reference_id));
  if (expected.units.some((u) => !present.has(u.reference_id))) return orderFailure('reference_id');

  // Unit level, per expected unit in reference_id order.
  const claims = new Map(input.claims.map((c) => [c.reference_id, c]));
  const foreign = new Set(input.foreign_capture_ids);
  const readById = new Map(read.units.map((u) => [u.reference_id, u]));
  // Capture ids held through another unit's stored claim.
  const claimedBy = new Map<string, string>();
  for (const claim of input.claims) {
    if (claim.capture_id !== null) claimedBy.set(claim.capture_id, claim.reference_id);
  }
  const seenInRead = new Set<string>();
  const readAt = Date.parse(read.read_at);

  const units: UnitMatch[] = [...expected.units].sort(byReferenceId).map((want) => {
    const got = readById.get(want.reference_id);
    if (got === undefined) throw new Error('unreachable: unit set was checked');
    const claim = claims.get(want.reference_id);
    const capture = got.capture;
    const status = capture === null ? null : capture.status;
    const result = (r: UnitMatch['result'], field: MatchField | null = null): UnitMatch => ({
      reference_id: want.reference_id,
      result: r,
      field,
      status,
    });
    // The capture id of this unit is recorded as seen even when the unit stops at an earlier check.
    const captureId = capture === null ? null : capture.capture_id;
    const duplicateInRead = captureId !== null && seenInRead.has(captureId);
    if (captureId !== null) seenInRead.add(captureId);

    if (got.payee_merchant_id !== want.payee_merchant_id) return result('mismatch', 'payee');
    if (got.amount.minor !== want.amount_minor) return result('mismatch', 'amount');
    if (capture === null || captureId === null) return result('no_capture');
    // What PayPal says it captured must be what was ordered: same currency and same minor units
    // (M1). Field `amount` stands for both: the contract has no separate capture field.
    if (
      capture.amount.currency !== expected.currency ||
      capture.amount.minor !== want.amount_minor
    ) {
      return result('mismatch', 'amount');
    }
    const holder = claimedBy.get(captureId);
    if (
      foreign.has(captureId) ||
      duplicateInRead ||
      (holder !== undefined && holder !== want.reference_id)
    ) {
      return result('mismatch', 'capture_id_reused');
    }
    if (claim !== undefined && claim.capture_id !== null && captureId !== claim.capture_id) {
      return result('mismatch', 'capture_id');
    }
    if (claim !== undefined && claim.claimed_at !== null && readAt < Date.parse(claim.claimed_at)) {
      return result('pending', 'read_before_claim');
    }
    if (RECEIVED.has(capture.status)) return result('matched');
    if (capture.status === 'REFUNDED') {
      // A capture first seen as REFUNDED has no verified sale to refund: a human looks at it.
      // Seen after our own verification (claim holds this capture id and no claim time) it is
      // the refund of a verified sale, which lane 05b books.
      const verified =
        claim !== undefined && claim.capture_id === captureId && claim.claimed_at === null;
      return verified ? result('matched') : result('mismatch', 'capture_id');
    }
    if (capture.status === 'PENDING') return result('pending');
    return result('declined');
  });
  return { level: 'units', ok: true, units };
}
