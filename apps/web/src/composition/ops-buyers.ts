// INT-UI0 / UI0.7 and INT-OPS-A / OPS-A.5: the reads of the operator Buyers tab: the case queue and one case.
// The queue is AL's read through ops-home.ts. The case page adds one single-use Idempotency-Key per action (the
// browser cannot make one) and carries the text of the message to the buyer, which only an operator may read.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import { readCaseDetail, readCaseQueue as readQueue } from './ops-home';
import { CASE_ACTION_KINDS } from '../lib/ops-cases-view';

export const readCaseQueue = readQueue;

export async function readCasePage(actor: Actor, id: string) {
  if (actor.kind !== 'operator') return null;
  const detail = await readCaseDetail(actor, id);
  if (detail === null) return null;
  const newKey = (await app()).engine.newKey;
  const keys: Record<string, string> = {};
  for (const kind of CASE_ACTION_KINDS) keys[kind] = newKey();
  return { detail, keys };
}

/** The injected clock, as the queue needs it to mark a case late. Empty for anyone but an operator. */
export async function readNow(actor: Actor): Promise<string> {
  const h = await (await app()).engine.opsHealth(actor);
  return h === null ? '' : h.now;
}
