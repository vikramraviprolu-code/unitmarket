// POB-M1: the dry run PayoutPort, the only one of this lane. It pays nothing and opens nothing: the answer is made from the
// key (deterministic ids), a repeat of a key is answered from memory and is not a second send, and a request that is not a
// dry run is refused so a sandbox payout is never pretended. No fetch, no socket, no credential.
import type { PayoutPort, PayoutSendRequest, PayoutSendResult } from '@umsbx/contracts';
import { payoutKey } from './payout';

/** The port plus what it has "sent", newest last. Only the last SENT_KEPT keys are kept in memory. */
export interface DryRunPayoutPort extends PayoutPort {
  readonly sent: readonly PayoutSendRequest[];
}
const SENT_KEPT = 500;

export function createDryRunPayoutPort(): DryRunPayoutPort {
  const answers = new Map<string, PayoutSendResult>();
  const sent: PayoutSendRequest[] = [];
  const invalid: PayoutSendResult = { kind: 'rejected', reason: 'invalid_request' };
  return {
    sent,
    send(req) {
      if (req.environment !== 'dryrun')
        return Promise.resolve({ kind: 'rejected', reason: 'dry_run_only' });
      let expected: string | null = null;
      try {
        expected = payoutKey(req.payout_id);
      } catch {
        expected = null;
      }
      if (
        expected === null ||
        req.idempotency_key !== expected ||
        !Number.isSafeInteger(req.amount.minor) ||
        req.amount.minor < 1 ||
        !/^[A-Z]{3}$/.test(req.amount.currency) ||
        req.payee_merchant_id.length === 0
      ) {
        return Promise.resolve(invalid);
      }
      const seen = answers.get(req.idempotency_key);
      if (seen !== undefined) return Promise.resolve(seen);
      const answer: PayoutSendResult = {
        kind: 'accepted',
        provider_ref: `DRYRUN-${req.idempotency_key}`,
        status: 'confirmed',
      };
      answers.set(req.idempotency_key, answer);
      sent.push(req);
      if (sent.length > SENT_KEPT) {
        const dropped = sent.shift();
        if (dropped !== undefined) answers.delete(dropped.idempotency_key);
      }
      return Promise.resolve(answer);
    },
  };
}
