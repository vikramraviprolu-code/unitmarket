import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BriefSchema, FitCardSchema } from '@umsbx/contracts';
import type { Actor, AgentDeps, ModelPort, ModelRequest } from '@umsbx/contracts';
import { discover, parseNeed } from './index';
import type { DiscoveryResult } from './index';
import {
  CLIMATE_BRIEF,
  addBuyer,
  count,
  depsWith,
  recordingModel,
  seededDb,
  type TestDb,
} from './support';
import { createScriptedModel } from '@umsbx/model';

let db: TestDb;
let deps: AgentDeps;
beforeAll(async () => {
  ({ db, deps } = await seededDb());
});
afterAll(async () => {
  await db.close();
});

const buyerActor = async (): Promise<Actor> => ({ kind: 'buyer', buyer_id: await addBuyer(db) });
async function brief(actor: Actor, text = CLIMATE_BRIEF) {
  const r = await parseNeed(deps, { actor, text });
  if (!r.ok) throw new Error(`parseNeed failed: ${r.error.code}`);
  return r.value;
}
async function proposal(actor: Actor, text = CLIMATE_BRIEF) {
  const b = await brief(actor, text);
  const r = await discover(deps, { actor, brief_id: b.brief_id });
  if (!r.ok) throw new Error(`discover failed: ${r.error.code}`);
  return { brief: b, result: r.value };
}
const asProposal = (r: DiscoveryResult) => {
  if (r.kind !== 'proposal') throw new Error(`expected proposal, got no_match ${r.reasons}`);
  return r;
};

describe('parseNeed', () => {
  it('parses the brief and stores it for the buyer', async () => {
    const actor = await buyerActor();
    const b = await brief(actor);
    expect(BriefSchema.parse(b)).toEqual(b);
    expect(b.buyer_id).toBe((actor as { buyer_id: string }).buyer_id);
    expect(b.ceiling).toEqual({ currency: 'USD', minor: 600 });
    expect(b.option).toBe('online_read');
    expect(b.language).toBe('en');
    expect(b.terms).toEqual(['climate', 'adaptation', 'cities']);
    expect(b.created_at).toBe('2026-10-21T10:00:00.000Z');
    const row = await db.query<{ buyer_id: string; raw_text: string; version: string }>(
      'SELECT buyer_id, raw_text, version FROM briefs WHERE id = $1',
      [b.brief_id],
    );
    expect(row.rows).toEqual([
      { buyer_id: b.buyer_id, raw_text: CLIMATE_BRIEF, version: 'scripted-v1' },
    ]);
  });

  it('only a buyer may state a need', async () => {
    for (const actor of [
      { kind: 'system' },
      { kind: 'publisher', publisher_id: 'pub_x' },
    ] as Actor[]) {
      const r = await parseNeed(deps, { actor, text: CLIMATE_BRIEF });
      expect(r).toEqual({ ok: false, error: { code: 'not_buyer' } });
    }
    const ghost = await parseNeed(deps, {
      actor: { kind: 'buyer', buyer_id: 'buy_nobody' },
      text: 'x',
    });
    expect(ghost).toEqual({ ok: false, error: { code: 'not_buyer' } });
  });

  it('a model error is reported as model_error and stores nothing', async () => {
    const before = await count(db, 'briefs');
    const bad: ModelPort = {
      model_id: 'bad',
      complete: async () => ({ kind: 'error', reason: 'upstream_down' }),
    };
    const r = await parseNeed(depsWith(db, bad), {
      actor: await buyerActor(),
      text: CLIMATE_BRIEF,
    });
    expect(r).toEqual({ ok: false, error: { code: 'model_error' } });
    expect(await count(db, 'briefs')).toBe(before);
  });

  it('model output that fails the schema is unparseable', async () => {
    const bad: ModelPort = {
      model_id: 'bad',
      complete: async () => ({
        kind: 'ok',
        output: { need: 5 },
        input_tokens: 0,
        output_tokens: 0,
      }),
    };
    const r = await parseNeed(depsWith(db, bad), {
      actor: await buyerActor(),
      text: CLIMATE_BRIEF,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unparseable' } });
  });

  it('a ceiling with no currency is not guessed', async () => {
    const r = await parseNeed(deps, { actor: await buyerActor(), text: 'tide tables under 6' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // "under 6" has no currency word or symbol: the buyer's own corridor currency is not assumed
      expect(r.value.ceiling).toBeNull();
    }
  });
});

describe('discover', () => {
  it('brief "climate adaptation for cities, under $6, read online, English" yields at most 5 quotes, all authorised, all within the ceiling', async () => {
    const actor = await buyerActor();
    const { brief: b, result } = await proposal(actor);
    const p = asProposal(result);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items.length).toBeLessThanOrEqual(5);
    for (const it of p.items) {
      expect(it.quote.kind).toBe('quote');
      expect(it.quote.source).toBe('discovery');
      expect(it.quote.option).toBe('online_read');
      expect(it.quote.price.minor).toBeLessThanOrEqual(600);
      expect(it.quote.price.currency).toBe('USD');
      expect(it.fit.offer_id).toBe(it.quote.offer_id);
      expect(FitCardSchema.parse(it.fit)).toEqual(it.fit);
      expect(it.title.length).toBeGreaterThan(0);
      expect(it.publisher).toBe('Harbour Ledger Review (fictional)');
      const o = await db.query<{ status: string }>('SELECT status FROM offers WHERE id = $1', [
        it.quote.offer_id,
      ]);
      expect(o.rows[0]!.status).toBe('authorised');
      const auth = await db.query('SELECT 1 FROM publisher_authorisations WHERE offer_id = $1', [
        it.quote.offer_id,
      ]);
      expect(auth.rows.length).toBeGreaterThan(0);
      const q = await db.query<{ price_minor: number; buyer_id: string }>(
        'SELECT price_minor, buyer_id FROM quotes WHERE id = $1',
        [it.quote.quote_id],
      );
      expect(q.rows).toEqual([{ price_minor: it.quote.price.minor, buyer_id: b.buyer_id }]);
    }
    // never the withdrawn, draft, keep-only or over-ceiling offers
    const ids = p.items.map((i) => i.quote.offer_id);
    for (const bad of ['c8', 'c9', 'c10', 'c11', 'c13']) {
      expect(ids.some((id) => id.endsWith(`_${bad}`))).toBe(false);
    }
    const stored = await db.query<{
      items: unknown;
      fit: unknown;
      buyer_id: string;
      brief_id: string;
    }>('SELECT items, fit, buyer_id, brief_id FROM proposals WHERE id = $1', [p.proposal_id]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.brief_id).toBe(b.brief_id);
    expect(stored.rows[0]!.buyer_id).toBe(b.buyer_id);
  });

  it('items are ranked by band, then sum of levels, then price, then offer id', async () => {
    const { result } = await proposal(await buyerActor());
    const p = asProposal(result);
    const rankOf = (band: string | null) =>
      ['strong', 'good', 'partial'].indexOf(band ?? '') + (band ? 0 : 3);
    const sum = (f: (typeof p.items)[number]['fit']) =>
      f.dimensions.reduce((s, d) => s + (d.level ?? 0), 0);
    for (let i = 1; i < p.items.length; i++) {
      const a = p.items[i - 1]!;
      const b = p.items[i]!;
      const ka = [rankOf(a.fit.band), -sum(a.fit), a.quote.price.minor, a.quote.offer_id] as const;
      const kb = [rankOf(b.fit.band), -sum(b.fit), b.quote.price.minor, b.quote.offer_id] as const;
      expect(
        ka[0] < kb[0] ||
          (ka[0] === kb[0] &&
            (ka[1] < kb[1] ||
              (ka[1] === kb[1] && (ka[2] < kb[2] || (ka[2] === kb[2] && ka[3] <= kb[3]))))),
      ).toBe(true);
    }
  });

  it('fit cards are honest: topic and budget evidence come from the facts', async () => {
    const { result } = await proposal(await buyerActor());
    const p = asProposal(result);
    for (const it of p.items) {
      const budget = it.fit.dimensions.find((d) => d.key === 'budget')!;
      const dollars = (it.quote.price.minor / 100).toFixed(2);
      expect(budget.evidence).toBe(`$${dollars} of your $6.00`);
      // language is a fit dimension, not a filter: the German article shows level 0, honestly
      expect(it.fit.dimensions.find((d) => d.key === 'language')!.level).toBe(
        it.quote.offer_id.endsWith('_c12') ? 0 : 3,
      );
      expect(it.fit.dimensions.find((d) => d.key === 'access')!.level).toBe(3);
    }
  });

  it('nothing fits gives no_match with reasons and no order or approval rows', async () => {
    const actor = await buyerActor();
    const quotes = await count(db, 'quotes');
    const proposals = await count(db, 'proposals');
    const { result } = await proposal(
      actor,
      'climate adaptation for cities, under $0.10, read online, English',
    );
    expect(result.kind).toBe('no_match');
    if (result.kind === 'no_match') {
      expect(result.reasons).toContain('above_ceiling');
      expect(new Set(result.reasons).size).toBe(result.reasons.length);
    }
    for (const t of ['orders', 'order_units', 'approvals', 'entitlements']) {
      expect(await count(db, t), t).toBe(0);
    }
    expect(await count(db, 'quotes')).toBe(quotes);
    expect(await count(db, 'proposals')).toBe(proposals);
  });

  it('a need that matches no listing gives no_match with no reasons and writes nothing', async () => {
    const quotes = await count(db, 'quotes');
    const { result } = await proposal(
      await buyerActor(),
      'quantum chromodynamics lattice, under $6, English',
    );
    expect(result).toEqual({ kind: 'no_match', reasons: [] });
    expect(await count(db, 'quotes')).toBe(quotes);
  });

  it('model picking an id outside candidates is dropped', async () => {
    const real = createScriptedModel();
    const seen: ModelRequest[] = [];
    const lying: ModelPort = {
      model_id: 'lying',
      async complete(r) {
        seen.push(r);
        const out = await real.complete(r);
        if (r.purpose !== 'pack_compose' || out.kind !== 'ok') return out;
        const o = out.output as { picks: { offer_id: string; reason: string }[] };
        return {
          ...out,
          output: {
            tool_calls: [],
            picks: [{ offer_id: 'ofr_not_a_candidate', reason: 'trust me' }, ...o.picks],
          },
        };
      },
    };
    const actor = await buyerActor();
    const d2 = depsWith(db, lying);
    const b = await parseNeed(d2, { actor, text: CLIMATE_BRIEF });
    if (!b.ok) throw new Error('parse');
    const r = await discover(d2, { actor, brief_id: b.value.brief_id });
    if (!r.ok) throw new Error(r.error.code);
    const p = asProposal(r.value);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items.some((i) => i.quote.offer_id === 'ofr_not_a_candidate')).toBe(false);
    const q = await db.query('SELECT 1 FROM quotes WHERE offer_id = $1', ['ofr_not_a_candidate']);
    expect(q.rows).toHaveLength(0);
  });

  it('a model that returns nothing usable gives no proposal and no quote', async () => {
    const quotes = await count(db, 'quotes');
    const junk: ModelPort = {
      model_id: 'junk',
      async complete(r) {
        return r.purpose === 'brief_parse'
          ? createScriptedModel().complete(r)
          : { kind: 'ok', output: 'not an object', input_tokens: 0, output_tokens: 0 };
      },
    };
    const actor = await buyerActor();
    const d2 = depsWith(db, junk);
    const b = await parseNeed(d2, { actor, text: CLIMATE_BRIEF });
    if (!b.ok) throw new Error('parse');
    const r = await discover(d2, { actor, brief_id: b.value.brief_id });
    expect(r).toEqual({ ok: true, value: { kind: 'no_match', reasons: [] } });
    expect(await count(db, 'quotes')).toBe(quotes);
  });

  it('unknown brief and not the owner are one answer (review 4 L1)', async () => {
    const owner = await buyerActor();
    const other = await buyerActor();
    const b = await brief(owner);
    expect(await discover(deps, { actor: owner, brief_id: 'brf_missing' })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await discover(deps, { actor: other, brief_id: b.brief_id })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await discover(deps, { actor: { kind: 'system' }, brief_id: b.brief_id })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('same brief, same ranked offers', async () => {
    const actor = await buyerActor();
    const b = await brief(actor);
    const run = async () => {
      const r = await discover(deps, { actor, brief_id: b.brief_id });
      if (!r.ok) throw new Error('x');
      return asProposal(r.value).items.map((i) => [i.quote.offer_id, i.fit]);
    };
    expect(await run()).toEqual(await run());
  });

  it('the model sees only the brief and listing facts: no price, no payee, no buyer', async () => {
    const rec = recordingModel(createScriptedModel());
    const d2 = depsWith(db, rec.model);
    const actor = await buyerActor();
    const b = await parseNeed(d2, { actor, text: CLIMATE_BRIEF });
    if (!b.ok) throw new Error('parse');
    await discover(d2, { actor, brief_id: b.value.brief_id });
    const compose = rec.requests.find((r) => r.purpose === 'pack_compose')!;
    const input = compose.input as { candidates: Record<string, unknown>[] };
    expect(input.candidates.length).toBeGreaterThan(0);
    for (const c of input.candidates) {
      expect(Object.keys(c).sort()).toEqual(['abstract', 'offer_id', 'title', 'topics']);
    }
    expect(Object.keys(compose.input as object).sort()).toEqual([
      'candidates',
      'ceiling_minor',
      'need',
      'terms',
    ]);
  });
});
