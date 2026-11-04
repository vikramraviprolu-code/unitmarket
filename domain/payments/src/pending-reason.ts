// MC2-L6 (D-083): the closed set of labels for the reason PayPal gave for a pending capture. Pure: it
// reads no row and writes none, and it changes no money state. Only the exact PayPal reason for a
// receiving account that must accept the payment by hand maps to "awaiting seller acceptance". Every
// other string, a missing one included, is the generic pending label, so a stored reason is never
// shown as it is.

/** The PayPal reason on a PENDING capture whose receiving account has to accept the payment itself. */
export const SELLER_ACCEPTANCE_REASON = 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION';

export type PendingReasonKind = 'awaiting_seller_acceptance' | 'payment_pending';

export const PENDING_REASON_LABEL: Record<PendingReasonKind, string> = {
  awaiting_seller_acceptance: 'Awaiting seller acceptance',
  payment_pending: 'Payment pending at PayPal',
};

export function pendingReasonKind(reason: string | null | undefined): PendingReasonKind {
  return reason === SELLER_ACCEPTANCE_REASON ? 'awaiting_seller_acceptance' : 'payment_pending';
}

export function pendingReasonLabel(reason: string | null | undefined): string {
  return PENDING_REASON_LABEL[pendingReasonKind(reason)];
}
