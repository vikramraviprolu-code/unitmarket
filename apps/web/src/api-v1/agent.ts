// API-B (G5 to G10, G12): the six tools an AI agent has over MCP. Each tool has a strict argument schema, the
// scopes it needs, and one answer shape: `{ status, ... }` where status `ok` / `bought` / ... is a success and
// anything else says why nothing happened. A tool never throws for a refusal. The agent acts as the buyer who
// gave it its key, and only inside the cap (mandate) that buyer set: no cap, no purchase.
//
// What this file adds on top of the Engine: the rights filter (an offer whose rights say ai_scope
// `not_allowed` is invisible to search and refused everywhere), the order of the checks in buy_unit, and the
// idempotency claim. Everything that touches money (the cap, the order, the approval) is in the domain and is
// reached through the Engine, the mandate service and the claim store of the composition root.
import { z } from 'zod';
import type { Actor, Scope } from '@umsbx/contracts';
import { searchOffers } from '../../composition.server';
import type { Engine, MandateService, OfferPage, PurchaseClaims } from '../../composition.server';

export const TOOL_NAMES = [
  'search_catalogue',
  'get_offer',
  'propose_pack',
  'open_unit',
  'check_budget',
  'buy_unit',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** What the tools need. Built once per request by the route from the composition root. */
export interface AgentCtx {
  engine: Engine;
  mandates: MandateService;
  claims: PurchaseClaims;
  /** The public origin (`https://...`), for the one link an agent hands a buyer. */
  origin: string;
  environment: 'dryrun' | 'sandbox';
}

/** Who is calling: the agent key, the buyer it acts for and the scopes it holds. */
export interface AgentCall {
  ctx: AgentCtx;
  key_id: string;
  buyer_id: string;
  scopes: readonly Scope[];
}

export type ToolOut = { status: string } & Record<string, unknown>;
export interface ToolResult {
  out: ToolOut;
  isError: boolean;
}

const ok = (out: ToolOut): ToolResult => ({ out, isError: false });
const refuse = (out: ToolOut): ToolResult => ({ out, isError: true });
const buyerOf = (c: AgentCall): Actor => ({ kind: 'buyer', buyer_id: c.buyer_id });

// ---------------------------------------------------------------------------------------------
// Argument schemas (strict: an extra field is an error, so an agent cannot smuggle a price or a mandate id).
// ---------------------------------------------------------------------------------------------
const SLUG = z.string().min(1).max(64);
const CODE = z.string().min(1).max(64);
const ID = z.string().min(1).max(200);
const KEY = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const OPTION = z.enum(['keep_retrieve', 'online_read']);

export const SearchArgs = z
  .object({
    q: z.string().min(1).max(200).optional(),
    max_price_minor: z.number().int().min(0).max(2_147_483_647).optional(),
    publisher: SLUG.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z
      .string()
      .regex(/^\d{1,6}$/)
      .optional(),
  })
  .strict();
export const GetOfferArgs = z.object({ publisher: SLUG, offer: CODE }).strict();
export const ProposeArgs = z.object({ need: z.string().min(1).max(2000) }).strict();
export const OpenArgs = z.object({ entitlement_id: ID }).strict();
export const BudgetArgs = z.object({}).strict();
export const BuyArgs = z
  .object({
    publisher: SLUG.optional(),
    offer: CODE.optional(),
    option: OPTION.optional(),
    proposal_id: ID.optional(),
    offer_ids: z.array(ID).min(1).max(5).optional(),
    idempotency_key: KEY,
  })
  .strict()
  .superRefine((a, ctx) => {
    const single = a.publisher !== undefined && a.offer !== undefined;
    const pack = a.proposal_id !== undefined && a.offer_ids !== undefined;
    const strayOfSingle =
      a.publisher !== undefined || a.offer !== undefined || a.option !== undefined;
    const strayOfPack = a.proposal_id !== undefined || a.offer_ids !== undefined;
    if (!((single && !strayOfPack) || (pack && !strayOfSingle))) {
      ctx.addIssue({
        code: 'custom',
        message: 'give publisher and offer, or proposal_id and offer_ids, not a mix',
        path: ['offer'],
      });
    }
  });

type SchemaOf<T extends z.ZodType> = z.infer<T>;

// ---------------------------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------------------------
interface ToolDef<S extends z.ZodType> {
  name: ToolName;
  description: string;
  scopes: readonly Scope[];
  schema: S;
  run(c: AgentCall, args: SchemaOf<S>): Promise<ToolResult>;
}
const def = <S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> => d;

const aiScopeOf = (o: OfferPage): string => o.rights.ai_scope;
const visibleToAgent = (o: OfferPage): boolean => o.on_sale && aiScopeOf(o) !== 'not_allowed';
const cheapest = (o: OfferPage): number => Math.min(...o.options.map((x) => x.price_minor));
const offerView = (o: OfferPage) => ({
  publisher: o.publisher_slug,
  offer: o.offer_code,
  offer_id: o.offer_id,
  title: o.title,
  abstract: o.abstract,
  currency: o.currency,
  options: o.options.map((x) => ({ option: x.option, price_minor: x.price_minor })),
  ai_scope: aiScopeOf(o),
  language: o.language,
});

const search = def({
  name: 'search_catalogue',
  description:
    'Search the offers on sale that an AI agent may buy. Filter by words (q, matched in title and abstract), by the lowest price of any option ' +
    '(max_price_minor, in minor units such as cents), or by publisher; page with limit and cursor. Offers whose ' +
    'rights do not allow AI are never listed. Read only.',
  scopes: ['catalogue:read'],
  schema: SearchArgs,
  async run(c, a) {
    // Lane A's search (the one GET /api/v1/catalogue/search uses) over the offers an agent may see: words in the
    // title and abstract, then price, then id. The AI-rights filter comes first.
    const visible = (await c.ctx.engine.listOffers()).filter(visibleToAgent);
    const byId = new Map(visible.map((o) => [o.offer_id, o]));
    const hits = searchOffers(
      visible.map((o) => ({
        offer_id: o.offer_id,
        title: o.title,
        abstract: o.abstract,
        publisher_slug: o.publisher_slug,
        status: 'authorised',
        min_price_minor: cheapest(o),
      })),
      {
        ...(a.q !== undefined ? { q: a.q } : {}),
        ...(a.publisher !== undefined ? { publisher: a.publisher } : {}),
        ...(a.max_price_minor !== undefined ? { max_price_minor: a.max_price_minor } : {}),
      },
    ).map((x) => byId.get(x.offer_id)!);
    const start = a.cursor === undefined ? 0 : Number(a.cursor);
    const limit = a.limit ?? 20;
    const page = hits.slice(start, start + limit);
    const next = start + limit < hits.length ? String(start + limit) : null;
    return ok({ status: 'ok', items: page.map(offerView), next_cursor: next });
  },
});

const getOffer = def({
  name: 'get_offer',
  description:
    'Read one offer by publisher and offer code: title, abstract, currency, the options with their prices and ' +
    'the AI rights. An offer that does not allow AI answers ai_not_allowed. Read only.',
  scopes: ['catalogue:read'],
  schema: GetOfferArgs,
  async run(c, a) {
    const o = await c.ctx.engine.offerPage({ publisher: a.publisher, offer: a.offer });
    if (o === null) return refuse({ status: 'not_found' });
    if (aiScopeOf(o) === 'not_allowed') {
      return refuse({
        status: 'ai_not_allowed',
        message: 'The publisher does not allow AI agents to buy this offer.',
      });
    }
    return ok({ status: 'ok', offer: { ...offerView(o), on_sale: o.on_sale } });
  },
});

const propose = def({
  name: 'propose_pack',
  description:
    'Describe what you need in a sentence and get a proposal: up to five offers that fit, with prices. ' +
    'Nothing is bought, approved or reserved. Pass the proposal_id and chosen offer_ids to buy_unit to buy.',
  scopes: ['catalogue:read'],
  schema: ProposeArgs,
  async run(c, a) {
    const d = await c.ctx.engine.discover({ actor: buyerOf(c), text: a.need });
    if (d.ai_off)
      return refuse({
        status: 'unavailable',
        message: 'Pack proposals are switched off right now.',
      });
    if ('parse_error' in d.result)
      return refuse({ status: 'invalid_need', reason: d.result.parse_error });
    if (!d.result.ok) return refuse({ status: 'not_found' });
    const r = d.result.value;
    if (r.kind === 'no_match') return ok({ status: 'no_match', reasons: r.reasons });
    const byId = new Map((await c.ctx.engine.listOffers()).map((o) => [o.offer_id, o]));
    const items = r.items.flatMap((i) => {
      const o = byId.get(i.quote.offer_id);
      if (o === undefined || !visibleToAgent(o)) return [];
      return [
        {
          offer_id: i.quote.offer_id,
          publisher: o.publisher_slug,
          offer: o.offer_code,
          title: i.title,
          option: i.quote.option,
          price_minor: i.quote.price.minor,
          currency: i.quote.price.currency,
          ai_scope: aiScopeOf(o),
        },
      ];
    });
    if (items.length === 0) return ok({ status: 'no_match', reasons: [] });
    return ok({ status: 'ok', proposal_id: r.proposal_id, items });
  },
});

const openUnit = def({
  name: 'open_unit',
  description:
    'Get a time-limited link to read or download a unit the buyer owns, by entitlement_id (from the buy_unit ' +
    'answer). A unit the buyer does not own is not_found.',
  scopes: ['library:read'],
  schema: OpenArgs,
  async run(c, a) {
    const issued = await c.ctx.engine.issueLink({
      entitlement_id: a.entitlement_id,
      actor: buyerOf(c),
    });
    if (!issued.ok) {
      return refuse(
        issued.error.code === 'not_found'
          ? { status: 'not_found' }
          : { status: issued.error.code, message: 'This unit cannot be opened now.' },
      );
    }
    const url = issued.value.url.startsWith('/')
      ? `${c.ctx.origin}${issued.value.url}`
      : issued.value.url;
    return ok({ status: 'ok', url, expires_at: issued.value.expires_at });
  },
});

const checkBudget = def({
  name: 'check_budget',
  description:
    'Say what your buyer still lets you spend: the money and purchases left under your cap (mandate), its ' +
    'currency, the largest single purchase and when it ends. Without a cap the answer is mandate_required, with ' +
    'the words to ask your buyer to set one. Read this before buy_unit.',
  scopes: ['agent:buy'],
  schema: BudgetArgs,
  async run(c) {
    const b = await c.ctx.mandates.budget({ buyer_id: c.buyer_id, agent_key_id: c.key_id });
    return ok(b);
  },
});

// ---------------------------------------------------------------------------------------------
// buy_unit.
// ---------------------------------------------------------------------------------------------
type BuyArgsT = z.infer<typeof BuyArgs>;
type Budget = Awaited<ReturnType<MandateService['budget']>>;

/** Cap refusals the order transaction reports, as the status an agent reads. */
const CAP_STATUS: Record<string, string> = {
  cap_exhausted: 'cap_exhausted',
  over_per_purchase: 'over_per_purchase',
  currency_mismatch: 'currency_mismatch',
};

const needMandate = (budget: Extract<Budget, { status: 'mandate_required' }>): ToolResult =>
  refuse({ status: 'mandate_required', reason: budget.reason, ask_buyer: budget.ask_buyer });

/** The text that decides "the same request": every argument except the key. Order does not matter. */
export function fingerprintOf(a: BuyArgsT): string {
  return JSON.stringify({
    publisher: a.publisher ?? null,
    offer: a.offer ?? null,
    option: a.option ?? null,
    proposal_id: a.proposal_id ?? null,
    offer_ids: a.offer_ids === undefined ? null : [...a.offer_ids].sort(),
  });
}

async function buy(c: AgentCall, a: BuyArgsT): Promise<ToolResult> {
  const { engine, claims } = c.ctx;
  if (!(await engine.agentBuyEnabled())) {
    return refuse({
      status: 'agent_buy_disabled',
      message: 'Agent buying is switched off right now.',
    });
  }
  const claim = { agent_key_id: c.key_id, idempotency_key: a.idempotency_key };
  const started = await claims.begin({ ...claim, fingerprint: fingerprintOf(a) });
  if (started.kind === 'reused') {
    return refuse({
      status: 'idempotency_key_reused',
      message: 'This idempotency_key was used for a different purchase.',
    });
  }
  if (started.kind === 'in_progress') {
    return ok({
      status: 'in_progress',
      message: 'The first call with this idempotency_key is still running.',
    });
  }
  if (started.kind === 'done') return ok(started.result as ToolOut);
  let done = false;
  try {
    const result = await purchase(c, a);
    if (result.out.status === 'bought' || result.out.status === 'buyer_approval_required') {
      await claims.finish({ ...claim, result: result.out });
      done = true;
    }
    return result;
  } finally {
    // Anything that bought nothing frees the key, so the same key may be tried again after the cause is fixed.
    if (!done) await claims.abandon(claim);
  }
}

async function purchase(c: AgentCall, a: BuyArgsT): Promise<ToolResult> {
  const { engine, mandates, environment } = c.ctx;
  const actor = buyerOf(c);
  const budget = await mandates.budget({ buyer_id: c.buyer_id, agent_key_id: c.key_id });
  if (budget.status === 'mandate_required') return needMandate(budget);

  // What is being bought: one offer, or the chosen offers of a proposal. Rights and currency first.
  let selection:
    | { kind: 'quote'; quote_id: string }
    | { kind: 'proposal'; proposal_id: string; offer_ids: string[] };
  if (a.publisher !== undefined && a.offer !== undefined) {
    const page = await engine.offerPage({ publisher: a.publisher, offer: a.offer });
    if (page === null) return refuse({ status: 'not_found' });
    if (aiScopeOf(page) === 'not_allowed') return refuse({ status: 'ai_not_allowed' });
    if (!page.on_sale) return refuse({ status: 'not_on_sale' });
    if (page.currency !== budget.currency) {
      return refuse({
        status: 'currency_mismatch',
        offer_currency: page.currency,
        mandate_currency: budget.currency,
      });
    }
    const option =
      a.option ?? [...page.options].sort((x, y) => x.price_minor - y.price_minor)[0]?.option;
    if (option === undefined) return refuse({ status: 'not_on_sale' });
    const q = await engine.quote({
      offer: { publisher_slug: a.publisher, offer_code: a.offer },
      actor,
      source: 'direct',
      option,
    });
    if (!q.ok) return refuse({ status: 'not_found' });
    if (q.value.kind === 'no_match') {
      return refuse(
        q.value.reason === 'already_owned' || q.value.reason === 'unpaid_order'
          ? { status: q.value.reason }
          : { status: 'not_available', reason: q.value.reason },
      );
    }
    selection = { kind: 'quote', quote_id: q.value.quote_id };
  } else {
    const wanted = a.offer_ids ?? [];
    const known = new Map((await engine.listOffers()).map((o) => [o.offer_id, o]));
    for (const id of wanted) {
      const o = known.get(id);
      if (o === undefined) return refuse({ status: 'not_found' });
      if (aiScopeOf(o) === 'not_allowed') return refuse({ status: 'ai_not_allowed' });
      if (o.currency !== budget.currency) {
        return refuse({
          status: 'currency_mismatch',
          offer_currency: o.currency,
          mandate_currency: budget.currency,
        });
      }
    }
    selection = { kind: 'proposal', proposal_id: a.proposal_id ?? '', offer_ids: wanted };
  }

  // The buyer accepted the terms when the cap was made; there is no per-order token for a purchase inside it.
  const approval = await engine.requestApproval({
    actor,
    selection,
    consent: { terms: true, identity_share: false },
    mandate_id: budget.mandate_id,
  });
  if (!approval.ok) {
    return refuse(
      approval.error.code === 'unknown_selection' || approval.error.code === 'not_owner'
        ? { status: 'not_found' }
        : { status: 'not_available', reason: approval.error.code },
    );
  }

  // The order and the cap are one transaction: the order exists only if the cap took it.
  const placed = await engine.payments.placeOrder({
    approval_id: approval.value.approval_id,
    token: approval.value.token,
    actor,
    mandate: { mandate_id: budget.mandate_id, agent_key_id: c.key_id },
  });
  if (!placed.ok) {
    const e = placed.error;
    if (e.code === 'mandate_refused') {
      if (CAP_STATUS[e.reason] !== undefined) return refuse({ status: CAP_STATUS[e.reason]! });
      const now = await mandates.budget({ buyer_id: c.buyer_id, agent_key_id: c.key_id });
      return now.status === 'mandate_required'
        ? needMandate(now)
        : refuse({ status: 'not_available', reason: e.reason });
    }
    if (e.code === 'already_owned' || e.code === 'order_open' || e.code === 'payee_unavailable') {
      return refuse({ status: e.code });
    }
    if (e.code === 'checkout_off')
      return refuse({ status: 'checkout_off', message: 'Checkout is switched off right now.' });
    return refuse({ status: 'not_available', reason: e.code });
  }
  const order = placed.value;

  if (environment === 'sandbox') {
    // A real payment needs its buyer: no PayPal call is made here. The order and its booked cap wait, and the
    // buyer opens our own page to pay. An order never paid ends, and the cap comes back.
    return ok({
      status: 'buyer_approval_required',
      environment: 'sandbox',
      order_ref: order.order_ref,
      checkout_url: `${c.ctx.origin}/buy/agent/${order.order_ref}`,
      message:
        'Send this link to your buyer. The purchase is held against your cap until they pay or it ends.',
    });
  }

  // Dry run: the pretend PayPal order is settled step by step, exactly like the buyer's own dry-run page.
  const co = await engine.payments.beginCheckout({ order_id: order.order_id, actor });
  if (co.ok) {
    const steps = (await engine.checkoutSteps({ order_ref: order.order_ref, actor })) ?? [];
    for (const s of steps) {
      if (
        await engine.dryRunApprove({
          order_ref: order.order_ref,
          actor,
          scenario: null,
          position: s.position,
        })
      ) {
        await engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor, scenario: null });
      }
    }
  }
  const view = await engine.orderView({ order_ref: order.order_ref, actor });
  // Reading the budget settles the paid order against the cap (and writes mandate.exhausted when it was the last).
  const after = await mandates.budget({ buyer_id: c.buyer_id, agent_key_id: c.key_id });
  if (view === null || view.status !== 'paid') {
    return refuse({
      status: 'not_paid',
      order_ref: order.order_ref,
      order_status: view?.status ?? 'unknown',
      message: view?.buyer_message ?? 'The order was not paid.',
    });
  }
  const library = await engine.library({ actor });
  const items = library
    .filter((e) => e.order_id === order.order_id)
    .map((e) => ({ entitlement_id: e.entitlement_id, title: e.title, publisher: e.publisher }));
  return ok({
    status: 'bought',
    order_ref: order.order_ref,
    items,
    environment,
    ...(after.status === 'active'
      ? {
          remaining_total_minor: after.remaining_total_minor,
          remaining_count: after.remaining_count,
        }
      : {}),
  });
}

const buyUnit = def({
  name: 'buy_unit',
  description:
    'Buy one offer (publisher and offer, optional option) or the chosen offers of a proposal (proposal_id and ' +
    'offer_ids, at most five). You need a cap (mandate) from your buyer first: call check_budget; with no cap you ' +
    'get mandate_required and must ask your buyer. Always send an idempotency_key (8 to 128 letters, digits, ' +
    '_ or -); a retry with the same key buys once. In the sandbox the buyer pays on a UnitMarket page, and you ' +
    'get buyer_approval_required with that link.',
  scopes: ['agent:buy'],
  schema: BuyArgs,
  run: buy,
});

const TOOLS = [search, getOffer, propose, openUnit, checkBudget, buyUnit] as const;

export interface ToolDescription {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool list for tools/list: name, description and a JSON Schema of the arguments. */
export function describeTools(): ToolDescription[] {
  return TOOLS.map((t) => {
    const json = z.toJSONSchema(t.schema, { target: 'draft-2020-12', io: 'input' }) as Record<
      string,
      unknown
    >;
    delete json['$schema'];
    return { name: t.name, description: t.description, inputSchema: json };
  });
}

/** Which issues names the arguments that failed, for the `fields` of an invalid_arguments answer. */
export function fieldsOf(error: z.ZodError): string[] {
  const names = new Set<string>();
  for (const i of error.issues) {
    if (i.code === 'unrecognized_keys') for (const k of i.keys) names.add(k);
    else names.add(i.path.length === 0 ? '(arguments)' : String(i.path[0]));
  }
  return [...names].slice(0, 20);
}

/** Runs one tool for one agent. The scopes are checked first, then the arguments, then the tool. */
export async function callTool(
  c: AgentCall,
  name: ToolName,
  rawArgs: unknown,
): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return refuse({ status: 'not_found' });
  if (!tool.scopes.every((s) => c.scopes.includes(s))) {
    return refuse({
      status: 'forbidden',
      message: 'This key does not hold the scope this tool needs.',
    });
  }
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse({ status: 'invalid_arguments', fields: fieldsOf(parsed.error) });
  }
  return (tool.run as (c: AgentCall, args: unknown) => Promise<ToolResult>)(c, parsed.data);
}
