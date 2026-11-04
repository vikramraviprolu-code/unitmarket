// API-W0 (F5): one facade per stakeholder over the Engine. A facade checks the kind of the actor first and
// answers forbidden for the wrong one, before the Engine is called; it then calls the Engine and adds no
// rule of its own. The bearer wrapper maps a principal to a domain actor (toActor) before any of these
// run, so an api_client reaches exactly the methods of its owner kind. W0 holds reads only: there is no
// method that buys, approves, opens a mandate, or changes a switch.
import { err, ok, toActor, type Actor, type Principal, type Result } from '@umsbx/contracts';
import type { Engine } from '../../composition.server';

export type FacadeError = { code: 'forbidden' | 'not_found' };
type R<T> = Promise<Result<T, FacadeError>>;
type Item<T> = NonNullable<Awaited<T>>;

const forbidden = (): Result<never, FacadeError> => err({ code: 'forbidden' });
const notFound = (): Result<never, FacadeError> => err({ code: 'not_found' });

export interface BuyerFacade {
  catalogue(actor: Actor): R<Awaited<ReturnType<Engine['listOffers']>>>;
  library(actor: Actor): R<Awaited<ReturnType<Engine['library']>>>;
  order(actor: Actor, order_ref: string): R<Item<ReturnType<Engine['orderView']>>>;
}
export function createBuyerFacade(engine: Engine): BuyerFacade {
  return {
    async catalogue(actor) {
      if (actor.kind !== 'buyer') return forbidden();
      return ok(await engine.listOffers());
    },
    async library(actor) {
      if (actor.kind !== 'buyer') return forbidden();
      return ok(await engine.library({ actor }));
    },
    async order(actor, order_ref) {
      if (actor.kind !== 'buyer') return forbidden();
      const view = await engine.orderView({ order_ref, actor });
      return view === null ? notFound() : ok(view);
    },
  };
}

export interface SellerFacade {
  home(actor: Actor): R<Item<ReturnType<Engine['publisherHome']>>>;
  sales(actor: Actor): R<Item<ReturnType<Engine['publisherSales']>>>;
}
export function createSellerFacade(engine: Engine): SellerFacade {
  return {
    async home(actor) {
      if (actor.kind !== 'publisher') return forbidden();
      const home = await engine.publisherHome(actor);
      return home === null ? notFound() : ok(home);
    },
    async sales(actor) {
      if (actor.kind !== 'publisher') return forbidden();
      const sales = await engine.publisherSales(actor);
      return sales === null ? notFound() : ok(sales);
    },
  };
}

/** Reads only. There is deliberately no method here that changes a switch or starts or stops PayPal. */
export interface OpsFacade {
  snapshot(actor: Actor): R<Item<ReturnType<Engine['opsSnapshot']>>>;
}
export function createOpsFacade(engine: Engine): OpsFacade {
  return {
    async snapshot(actor) {
      if (actor.kind !== 'operator') return forbidden();
      const snap = await engine.opsSnapshot(actor);
      return snap === null ? notFound() : ok(snap);
    },
  };
}

/** What an agent key may do in W0: read, for the buyer it acts for. Buying comes with lane B. */
export interface AgentFacade {
  catalogue(p: Principal): ReturnType<BuyerFacade['catalogue']>;
  library(p: Principal): ReturnType<BuyerFacade['library']>;
  order(p: Principal, order_ref: string): ReturnType<BuyerFacade['order']>;
}
export function createAgentFacade(buyer: BuyerFacade): AgentFacade {
  return {
    async catalogue(p) {
      return p.kind === 'agent' ? buyer.catalogue(toActor(p)) : forbidden();
    },
    async library(p) {
      return p.kind === 'agent' ? buyer.library(toActor(p)) : forbidden();
    },
    async order(p, order_ref) {
      return p.kind === 'agent' ? buyer.order(toActor(p), order_ref) : forbidden();
    },
  };
}
