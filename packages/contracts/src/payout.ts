// POB-M1 (D-089): the payout to a publisher and the fee on top. Constants, the payout states and the one port a payout
// goes through. In this lane the only implementation of the port is the dry run in @umsbx/payments: nothing here knows
// a PayPal host, a credential or a socket.
import { z } from 'zod';
import type { EnvironmentLabel, Id, Money } from './primitives';

/** The fee on top is 0 to 30 percent of the publisher's price: 3000 basis points at most (spec POB-M1, review of 4 Nov). */
export const FEE_BPS_MAX = 3000;

/** One payout is at most this many minor units (a database CHECK); a larger sum is cut into several payouts. */
export const PAYOUT_MAX_MINOR = 100_000_000;

/** A failed payout holds its units this long (24 hours); then it is cancelled and the units are paid again. */
export const PAYOUT_RETRY_AFTER_MS = 86_400_000;

/**
 * due: created, not yet handed to the port. sending: committed before the port is called; found again after a crash
 * it is sent with the same key, never replaced. sent: the provider took it. confirmed: it is final (also a payout of 0
 * that was netted against refunds, which is never sent). failed: the provider refused it. cancelled: given up, its
 * units are free again. Cancel is possible only from due or failed.
 */
export const PayoutStateSchema = z.enum([
  'due',
  'sending',
  'sent',
  'confirmed',
  'failed',
  'cancelled',
]);
export type PayoutState = z.infer<typeof PayoutStateSchema>;

export interface PayoutSendRequest {
  /** The payout row. */
  payout_id: Id;
  /** `umsP-<payout id>`: stored on the row and the same on every resend. */
  idempotency_key: string;
  publisher_id: Id;
  /** The payee stored on the payout when it was created (a legacy merchant id until the verified PayPal link of POB-P1). */
  payee_merchant_id: string;
  amount: Money;
  environment: EnvironmentLabel;
}

export type PayoutSendResult =
  | { kind: 'accepted'; provider_ref: string; status: 'sent' | 'confirmed' }
  | { kind: 'rejected'; reason: string }
  /** Nothing reached the provider (a switch is off, the lease is gone): no state changes, the send is tried again. */
  | { kind: 'blocked'; by: 'kill_switch' | 'lease' };

/** The only way money goes out of the collection account. A repeat of one key must not pay twice. */
export interface PayoutPort {
  send(req: PayoutSendRequest): Promise<PayoutSendResult>;
}
