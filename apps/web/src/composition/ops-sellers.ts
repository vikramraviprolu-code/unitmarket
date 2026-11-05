// INT-UI0 / UI0.7 and INT-OPS-A / OPS-A.7: the reads of the operator Sellers tab. Today it shows the shared payee
// line, which comes from the operations snapshot. The two seller queues (/ops/publishers and /ops/payee-requests)
// are read only for an operator without the authenticator code: the reads here answer any operator, flag whether the
// session has the code, and never carry a whole merchant id (the domain gives the last four). The writes keep their
// own check, in the domain function and again in the route.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { OpsSnapshot } from '../server/access';

type OperatorActor = Extract<Actor, { kind: 'operator' }>;

export interface OpsSellersRead {
  snap: OpsSnapshot;
}

export async function readOpsSellers(actor: OperatorActor): Promise<OpsSellersRead | null> {
  const snap = await (await app()).engine.opsSnapshot(actor);
  return snap === null ? null : { snap };
}

type Engine = Awaited<ReturnType<typeof app>>['engine'];
type Listed<T> = T extends { ok: true; value: infer V } ? V : never;

export interface OpsPublishersRead {
  publishers: Listed<Awaited<ReturnType<Engine['opsPublishers']['list']>>>['publishers'];
  awaiting: Listed<Awaited<ReturnType<Engine['opsPublishers']['list']>>>['awaiting'];
  environment: Listed<Awaited<ReturnType<Engine['opsPublishers']['list']>>>['environment'];
  applicants: Listed<Awaited<ReturnType<Engine['opsApplicants']['list']>>>['applicants'];
  agreements: Listed<Awaited<ReturnType<Engine['opsAgreements']['list']>>>['agreements'];
  /** POB-P1: who can sign in. Needs the second factor, so it is empty for an operator without the code. */
  access: Listed<Awaited<ReturnType<Engine['opsPublisherAccess']['list']>>>['rows'];
  /** True when the session has the authenticator code, so the page can switch its buttons on. */
  mfa: boolean;
}

/** Null for anyone who is not an operator; the page then sends the visitor to sign in. */
export async function readOpsPublishers(actor: Actor): Promise<OpsPublishersRead | null> {
  if (actor.kind !== 'operator') return null;
  const e = (await app()).engine;
  const pubs = await e.opsPublishers.list(actor);
  const apps = await e.opsApplicants.list(actor);
  const agr = await e.opsAgreements.list(actor);
  if (!pubs.ok || !apps.ok || !agr.ok) return null;
  // The access list needs the second factor; without the code the queue is still read and the rows stay empty.
  let access: OpsPublishersRead['access'] = [];
  if (actor.mfa === true) {
    const acc = await e.opsPublisherAccess.list(actor);
    if (!acc.ok) return null;
    access = acc.value.rows;
  }
  return {
    publishers: pubs.value.publishers,
    awaiting: pubs.value.awaiting,
    environment: pubs.value.environment,
    applicants: apps.value.applicants,
    agreements: agr.value.agreements,
    access,
    mfa: actor.mfa === true,
  };
}

export interface OpsPayeeQueueRead {
  requests: Listed<Awaited<ReturnType<Engine['payee']['openRequests']>>>['requests'];
  environment: Listed<Awaited<ReturnType<Engine['payee']['openRequests']>>>['environment'];
  mfa: boolean;
}

export async function readOpsPayeeQueue(actor: Actor): Promise<OpsPayeeQueueRead | null> {
  if (actor.kind !== 'operator') return null;
  const r = await (await app()).engine.payee.openRequests(actor);
  if (!r.ok) return null;
  return { requests: r.value.requests, environment: r.value.environment, mfa: actor.mfa === true };
}
