// INT-UI0 / UI0.7 and INT-OPS-A / OPS-A.7: the reads of the operator Sellers tab. Today it shows the shared payee
// line, which comes from the operations snapshot. The two seller queues (/ops/publishers and /ops/payee-requests)
// are read only for an operator without the authenticator code: the reads here answer any operator, flag whether the
// session has the code, and never carry a whole merchant id (the domain gives the last four). The writes keep their
// own check, in the domain function and again in the route.
import type { Actor, TxnLine } from '@umsbx/contracts';
import { app, listTransactions, sellerLine } from '../server/access';
import { shownId } from '../lib/ops-entity-view';
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
  /** DOMAIN-PROOF-2: the web addresses of every publisher (no code), for the vouch and remove buttons. */
  domains: Listed<Awaited<ReturnType<Engine['opsDomains']['list']>>>['domains'];
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
  const doms = await e.opsDomains.list(actor);
  if (!pubs.ok || !apps.ok || !agr.ok || !doms.ok) return null;
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
    domains: doms.value.domains,
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

// INT-OPS-C / OPS-C.2: one seller. Offers (the newest version of each), sales (SR1's list filtered by seller, through
// sellerLine, so no buyer, key, mandate or order total), payee status and the agreement version. The seller's own
// name and the merchant id need the second factor; the merchant id shows as its last four without it. Null for
// anyone who is not an operator and for an unknown seller.
export interface SellerPageRead {
  environment: OpsSnapshot['environment'];
  mfa: boolean;
  seller: { id: string; slug: string | null; display_name: string | null; country: string };
  offers: {
    id: string;
    title: string;
    version: string;
    status: string;
    currency: string;
    valid_from: string;
  }[];
  sales: TxnLine[];
  payee: { verified: boolean; merchant: string | null };
  agreement: { terms_version: string; accepted_at: string } | null;
}

export async function readSellerPage(actor: Actor, id: string): Promise<SellerPageRead | null> {
  if (actor.kind !== 'operator') return null;
  const mfa = actor.mfa === true;
  const a = await app();
  const p = (
    await a.db.query<{
      id: string;
      slug: string;
      display_name: string;
      country: string;
      paypal_merchant_id: string | null;
      payee_verified_at: string | Date | null;
    }>(
      'SELECT id, slug, display_name, country, paypal_merchant_id, payee_verified_at FROM publishers WHERE id = $1',
      [id],
    )
  ).rows[0];
  if (p === undefined) return null;
  const now = a.security.clock.now();
  const offers = await a.db.query<{
    id: string;
    title: string;
    version: string;
    status: string;
    currency: string;
    valid_from: string | Date;
  }>(
    `SELECT DISTINCT ON (o.id) o.id, ar.title, o.version, o.status, o.currency, o.valid_from
       FROM offers o JOIN articles ar ON ar.id = o.article_id
      WHERE o.publisher_id = $1 ORDER BY o.id, o.created_at DESC, o.version DESC`,
    [p.id],
  );
  const listed = await listTransactions(
    a.db,
    { ...actor, mfa: false },
    { seller: p.id, limit: '100' },
    { now },
  );
  const agr = (
    await a.db.query<{ terms_version: string; accepted_at: string | Date }>(
      `SELECT terms_version, accepted_at FROM publisher_agreements WHERE publisher_id = $1
        ORDER BY accepted_at DESC, id DESC LIMIT 1`,
      [p.id],
    )
  ).rows[0];
  return {
    environment: a.environment,
    mfa,
    seller: {
      id: p.id,
      slug: mfa ? p.slug : null,
      display_name: mfa ? p.display_name : null,
      country: p.country,
    },
    offers: offers.rows.map((o) => ({
      id: o.id,
      title: o.title,
      version: o.version,
      status: o.status,
      currency: o.currency,
      valid_from: new Date(o.valid_from).toISOString(),
    })),
    sales: listed.rows.map((r) => sellerLine(r, now)),
    payee: { verified: p.payee_verified_at !== null, merchant: shownId(p.paypal_merchant_id, mfa) },
    agreement:
      agr === undefined
        ? null
        : {
            terms_version: agr.terms_version,
            accepted_at: new Date(agr.accepted_at).toISOString(),
          },
  };
}
