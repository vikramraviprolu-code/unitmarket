// INT-OPS-A / OPS-A.6 (A3): the map from Money to the Problems page. A failing invariant links to
// /ops/money/problems?inv=INV1..INV7 and an operation state tile links to ?op=<state>. The ids and the states are
// closed lists here, checked against the real ones in the test, so a link never carries a value the page cannot read.
import { OperationStateSchema } from '@umsbx/contracts';

export const INVARIANT_IDS = ['INV1', 'INV2', 'INV3', 'INV4', 'INV5', 'INV6', 'INV7'] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];
export type OperationState = (typeof OperationStateSchema.options)[number];

export const INVARIANT_PROBLEMS_URL = Object.fromEntries(
  INVARIANT_IDS.map((id) => [id, `/ops/money/problems?inv=${id}`]),
) as Record<InvariantId, string>;

export const OPERATION_PROBLEMS_URL = Object.fromEntries(
  OperationStateSchema.options.map((s) => [s, `/ops/money/problems?op=${s}`]),
) as Record<OperationState, string>;

const isInvariant = (id: string): id is InvariantId => (INVARIANT_IDS as readonly string[]).includes(id);
const isOperation = (s: string): s is OperationState => (OperationStateSchema.options as readonly string[]).includes(s);

/** A link for a failing invariant only; null when it holds or the id is not one of the seven. */
export const invariantLink = (id: string, ok: boolean): string | null =>
  ok || !isInvariant(id) ? null : INVARIANT_PROBLEMS_URL[id];

export const operationLink = (state: string): string | null =>
  isOperation(state) ? OPERATION_PROBLEMS_URL[state] : null;

export type ProblemsQuery =
  | { kind: 'inv'; id: InvariantId }
  | { kind: 'op'; state: OperationState }
  | { kind: 'none' };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** One invariant id or one state; anything else is the overview. The invariant wins when both are given. */
export function parseProblemsQuery(sp: Record<string, string | string[] | undefined>): ProblemsQuery {
  const inv = first(sp['inv']);
  if (inv !== undefined && isInvariant(inv)) return { kind: 'inv', id: inv };
  const op = first(sp['op']);
  if (op !== undefined && isOperation(op)) return { kind: 'op', state: op };
  return { kind: 'none' };
}

export const INVARIANT_WORDS: Record<InvariantId, string> = {
  INV1: 'Ledger sale minus refunds equals the captured amount of each unit',
  INV2: 'Every available item has a verified capture',
  INV3: 'Every captured unit has its paid items',
  INV4: 'Every access window ends when the event log says it should',
  INV5: 'Every order in flight has an operation that is polled',
  INV6: 'Every open refund request has an operation that is polled',
  INV7: 'Per seller, the ledger matches captured minus refunded money',
};
export const OPERATION_WORDS: Record<OperationState, string> = {
  prepared: 'Prepared',
  sent: 'Sent',
  unknown: 'Unknown',
  confirmed: 'Confirmed',
  failed: 'Failed',
};
