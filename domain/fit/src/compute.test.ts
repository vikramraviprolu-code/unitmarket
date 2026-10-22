import { describe, expect, it } from 'vitest';
import type { ArticleFacts, Brief, FitCard, Offer } from '@umsbx/contracts';
import { computeFit, rankFit } from './index';

const NOW = new Date('2026-10-21T10:00:00.000Z');
const day = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * day).toISOString();

const brief = (over: Partial<Brief> = {}): Brief => ({
  brief_id: 'brf_1',
  buyer_id: 'buy_1',
  need: 'climate adaptation for cities',
  ceiling: { currency: 'USD', minor: 600 },
  option: 'online_read',
  language: 'en',
  terms: ['climate', 'adaptation', 'cities'],
  created_at: NOW.toISOString(),
  ...over,
});
const article = (over: Partial<ArticleFacts> = {}): ArticleFacts => ({
  id: 'art_1',
  publisher_id: 'pub_1',
  title: 'Climate adaptation for coastal cities',
  abstract: 'Plans that work.',
  language: 'en',
  topics: ['planning'],
  published_at: ago(10),
  sha256: 'a'.repeat(64),
  content_key: 'k',
  ...over,
});
const offer = (over: Partial<Offer> = {}): Offer => ({
  id: 'ofr_1',
  version: 'v1',
  publisher_id: 'pub_1',
  article_id: 'art_1',
  status: 'authorised',
  currency: 'USD',
  options: [
    { option: 'keep_retrieve', price_minor: 500, policy_id: 'pol_k', policy_version: '1' },
    { option: 'online_read', price_minor: 400, policy_id: 'pol_o', policy_version: '1' },
  ],
  affordability: { renegotiation_allowed: false, floor_minor: null },
  terms_version: 'terms-1',
  rights: { scope: 'personal_use', ai_scope: 'review', redistribution: false },
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_until: null,
  superseded_by: null,
  ...over,
});
const fit = (b: Brief, a = article(), o = offer(), price = 400): FitCard =>
  computeFit(b, { offer: o, article: a, price_minor: price }, NOW);
const dim = (c: FitCard, key: string) => c.dimensions.find((d) => d.key === key)!;

describe('each dimension level from its rule with an evidence string', () => {
  it('topic: share of brief terms found in title, abstract or topics', () => {
    const t = (terms: string[], a: Partial<ArticleFacts> = {}) =>
      dim(fit(brief({ terms }), article(a)), 'topic');
    expect(t(['zebra', 'quartz'])).toMatchObject({ level: 0, evidence: '0 of 2 terms' });
    expect(t(['climate', 'zebra', 'quartz'])).toMatchObject({ level: 1, evidence: '1 of 3 terms' });
    expect(t(['climate', 'cities', 'zebra'])).toMatchObject({ level: 2, evidence: '2 of 3 terms' });
    expect(t(['climate', 'cities'])).toMatchObject({ level: 3, evidence: '2 of 2 terms' });
    // abstract and topics count, matching is whole-word and case-insensitive
    expect(t(['PLANS', 'planning'])).toMatchObject({ level: 3, evidence: '2 of 2 terms' });
    expect(t(['clim'])).toMatchObject({ level: 0 });
    expect(dim(fit(brief({ terms: [] })), 'topic')).toMatchObject({ level: null });
  });

  it('topic: 3 of 4 terms is level 3 (more than two thirds), 2 of 4 is level 2', () => {
    const a = article({ title: 'alpha beta gamma', abstract: '', topics: [] });
    expect(
      dim(fit(brief({ terms: ['alpha', 'beta', 'gamma', 'delta'] }), a), 'topic'),
    ).toMatchObject({
      level: 3,
      evidence: '3 of 4 terms',
    });
    expect(
      dim(fit(brief({ terms: ['alpha', 'beta', 'delta', 'omega'] }), a), 'topic'),
    ).toMatchObject({
      level: 2,
      evidence: '2 of 4 terms',
    });
  });

  it('budget: at most half 3, at most three quarters 2, at most the ceiling 1', () => {
    const b = (price: number) => dim(fit(brief(), article(), offer(), price), 'budget');
    expect(b(300)).toMatchObject({ level: 3, evidence: '$3.00 of your $6.00' });
    expect(b(301)).toMatchObject({ level: 2 });
    expect(b(450)).toMatchObject({ level: 2, evidence: '$4.50 of your $6.00' });
    expect(b(451)).toMatchObject({ level: 1 });
    expect(b(600)).toMatchObject({ level: 1, evidence: '$6.00 of your $6.00' });
    expect(b(400).evidence).toBe('$4.00 of your $6.00');
  });

  it('budget: formats by currency minor units', () => {
    const o = offer({ currency: 'GBP' });
    const d = dim(
      fit(brief({ ceiling: { currency: 'GBP', minor: 600 } }), article(), o, 90),
      'budget',
    );
    expect(d.evidence).toBe('£0.90 of your £6.00');
    const jpy = dim(
      fit(
        brief({ ceiling: { currency: 'JPY', minor: 600 } }),
        article(),
        offer({ currency: 'JPY' }),
        200,
      ),
      'budget',
    );
    expect(jpy.evidence).toBe('JPY 200 of your JPY 600');
  });

  it('access: 3 when the requested option is offered, null when none is named', () => {
    expect(dim(fit(brief()), 'access')).toMatchObject({ level: 3 });
    expect(dim(fit(brief({ option: null })), 'access')).toMatchObject({ level: null });
    expect(dim(fit(brief({ option: 'keep_retrieve' })), 'access').evidence).toMatch(/keep/i);
  });

  it('access: a requested option the offer does not carry is level 0, not a guess', () => {
    const o = offer({
      options: [{ option: 'keep_retrieve', price_minor: 500, policy_id: 'p', policy_version: '1' }],
    });
    expect(dim(fit(brief(), article(), o), 'access')).toMatchObject({ level: 0 });
  });

  it('language: 3 equal, 0 different, null unknown', () => {
    expect(dim(fit(brief()), 'language')).toMatchObject({ level: 3 });
    expect(dim(fit(brief({ language: 'EN' })), 'language')).toMatchObject({ level: 3 });
    expect(dim(fit(brief({ language: 'de' })), 'language')).toMatchObject({ level: 0 });
    expect(dim(fit(brief({ language: null })), 'language')).toMatchObject({ level: null });
    expect(dim(fit(brief(), article({ language: '' })), 'language')).toMatchObject({ level: null });
  });

  it('recency: under 30 days 3, under a year 2, older 1', () => {
    const r = (days: number) => dim(fit(brief(), article({ published_at: ago(days) })), 'recency');
    expect(r(29)).toMatchObject({ level: 3, evidence: '29 days old' });
    expect(r(30)).toMatchObject({ level: 2, evidence: '1 month old' });
    expect(r(364)).toMatchObject({ level: 2 });
    expect(r(365)).toMatchObject({ level: 1, evidence: '1 year old' });
    expect(r(800)).toMatchObject({ level: 1, evidence: '2 years old' });
    expect(r(1)).toMatchObject({ evidence: '1 day old' });
  });

  it('recency: a date in the future is not assessed', () => {
    expect(dim(fit(brief(), article({ published_at: ago(-3) })), 'recency')).toMatchObject({
      level: null,
    });
  });

  it('five dimensions in fixed order with fixed bases', () => {
    const c = fit(brief());
    expect(c.dimensions.map((d) => [d.key, d.basis])).toEqual([
      ['topic', 'keyword_overlap'],
      ['budget', 'price_vs_ceiling'],
      ['access', 'option_offered'],
      ['language', 'language_equal'],
      ['recency', 'publish_date'],
    ]);
    expect(c.offer_id).toBe('ofr_1');
    for (const d of c.dimensions) {
      expect(d.label.split(' ').length).toBeLessThanOrEqual(3);
      expect(d.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe('missing ceiling gives budget null, never a guess', () => {
  it('no ceiling', () => {
    const d = dim(fit(brief({ ceiling: null })), 'budget');
    expect(d.level).toBeNull();
    expect(d.evidence).not.toMatch(/\d/);
  });
  it('a ceiling in another currency is not compared', () => {
    const d = dim(fit(brief({ ceiling: { currency: 'EUR', minor: 600 } })), 'budget');
    expect(d.level).toBeNull();
  });
});

describe('band derived only from levels', () => {
  const only = (levels: (0 | 1 | 2 | 3 | null)[]): FitCard => {
    // Build a brief and facts that produce exactly these levels for topic, budget, access, language, recency.
    const [topic = null, budget = null, access = null, language = null, recency = null] = levels;
    const terms = ['aa', 'bb', 'cc'];
    const title = { 0: 'zz', 1: 'aa', 2: 'aa bb', 3: 'aa bb cc' }[topic ?? 0];
    const b = brief({
      terms: topic === null ? [] : terms,
      ceiling: budget === null ? null : { currency: 'USD', minor: 1000 },
      option: access === null ? null : access === 0 ? 'keep_retrieve' : 'online_read',
      language: language === null ? null : language === 0 ? 'de' : 'en',
    });
    const price = budget === null ? 100 : { 0: 1000, 1: 1000, 2: 750, 3: 500 }[budget]!;
    const a = article({
      title,
      abstract: '',
      topics: [],
      published_at: recency === null ? ago(-5) : ago({ 0: 400, 1: 400, 2: 100, 3: 5 }[recency]!),
    });
    const o =
      access === 0
        ? offer({
            options: [
              { option: 'online_read', price_minor: price, policy_id: 'p', policy_version: '1' },
            ],
          })
        : offer();
    return computeFit(b, { offer: o, article: a, price_minor: price }, NOW);
  };

  it('strong: no level below 2 and at least three non-null', () => {
    expect(only([3, 2, 3, 3, 3]).band).toBe('strong');
    expect(only([2, 2, 2, null, null]).band).toBe('strong');
  });
  it('a level of 1 anywhere stops strong', () => {
    expect(only([3, 3, 3, 3, 1]).band).toBe('good');
  });
  it('good: mean of non-null levels at least 1.5', () => {
    expect(only([3, 0, 3, 3, 3]).band).toBe('good');
    expect(only([2, 1, null, null, null]).band).toBe('good');
  });
  it('partial: mean below 1.5', () => {
    expect(only([0, 1, 3, 0, 1]).band).toBe('partial');
    expect(only([1, 1, null, null, null]).band).toBe('partial');
  });
  it('two non-null levels at level 2 or more are not strong (needs three)', () => {
    expect(only([3, 3, null, null, null]).band).toBe('good');
  });
  it('null when fewer than two dimensions are assessed', () => {
    expect(only([3, null, null, null, null]).band).toBeNull();
    expect(only([null, null, null, null, null]).band).toBeNull();
  });
  it('the band ignores everything but levels', () => {
    const a = fit(brief());
    const b = fit(brief(), article({ title: 'Climate adaptation for coastal cities!' }));
    expect(a.band).toBe(b.band);
  });
});

describe('ranking', () => {
  const card = (
    offer_id: string,
    band: FitCard['band'],
    levels: (0 | 1 | 2 | 3 | null)[],
  ): FitCard => ({
    offer_id,
    band,
    dimensions: levels.map((level, i) => ({
      key: (['topic', 'budget', 'access', 'language', 'recency'] as const)[i]!,
      label: 'x',
      level,
      basis: (
        [
          'keyword_overlap',
          'price_vs_ceiling',
          'option_offered',
          'language_equal',
          'publish_date',
        ] as const
      )[i]!,
      evidence: 'e',
    })),
  });
  it('band, then sum of levels, then price, then offer id', () => {
    const items = [
      { fit: card('ofr_d', 'good', [2, 2, 2, 2, 2]), price_minor: 100 },
      { fit: card('ofr_c', 'strong', [2, 2, 2, 2, 2]), price_minor: 900 },
      { fit: card('ofr_b', 'strong', [3, 3, 3, 3, 3]), price_minor: 900 },
      { fit: card('ofr_a', 'strong', [3, 3, 3, 3, 3]), price_minor: 500 },
      { fit: card('ofr_0', 'strong', [3, 3, 3, 3, 3]), price_minor: 500 },
      { fit: card('ofr_n', null, [3, null, null, null, null]), price_minor: 1 },
      { fit: card('ofr_p', 'partial', [3, 0, 0, 0, 0]), price_minor: 1 },
    ];
    const order = rankFit(items).map((i) => i.fit.offer_id);
    expect(order).toEqual(['ofr_0', 'ofr_a', 'ofr_b', 'ofr_c', 'ofr_d', 'ofr_p', 'ofr_n']);
  });
  it('does not mutate its input', () => {
    const items = [
      { fit: card('ofr_b', 'good', [2, 2, 2, 2, 2]), price_minor: 1 },
      { fit: card('ofr_a', 'good', [2, 2, 2, 2, 2]), price_minor: 1 },
    ];
    rankFit(items);
    expect(items[0]!.fit.offer_id).toBe('ofr_b');
  });
});

// Small seeded generator (mulberry32): the property runs are reproducible and use no real randomness.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = [
  'climate',
  'city',
  'tide',
  'harbour',
  'bus',
  'garden',
  'history',
  'cost',
  'knot',
  'rain',
];
function randomCase(r: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const terms = Array.from({ length: Math.floor(r() * 6) }, () => pick(WORDS));
  const b = brief({
    terms,
    ceiling:
      r() < 0.3
        ? null
        : { currency: pick(['USD', 'GBP', 'EUR'] as const), minor: Math.floor(r() * 2000) },
    option: pick(['keep_retrieve', 'online_read', null] as const),
    language: pick(['en', 'de', null] as const),
  });
  const a = article({
    title: Array.from({ length: 3 }, () => pick(WORDS)).join(' '),
    abstract: Array.from({ length: 5 }, () => pick(WORDS)).join(' '),
    topics: [pick(WORDS)],
    language: pick(['en', 'de', 'fr', ''] as const),
    published_at: new Date(NOW.getTime() - Math.floor((r() * 1500 - 20) * day)).toISOString(),
  });
  const o = offer({ currency: pick(['USD', 'GBP'] as const) });
  return { b, a, o, price: Math.floor(r() * 2500) };
}

describe('purity and honesty', () => {
  it('same inputs same card (500 runs)', () => {
    const r = rng(14);
    for (let n = 0; n < 500; n++) {
      const { b, a, o, price } = randomCase(r);
      const bs = JSON.stringify(b);
      const first = computeFit(b, { offer: o, article: a, price_minor: price }, NOW);
      const second = computeFit(
        JSON.parse(bs) as Brief,
        { offer: o, article: a, price_minor: price },
        new Date(NOW),
      );
      expect(second).toEqual(first);
      expect(JSON.stringify(b)).toBe(bs);
    }
  });

  it('no field anywhere holds a percentage or probability', () => {
    const r = rng(15);
    const bad = /%|percent|probab|likel|chance|score|confiden/i;
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'number') {
        expect(Number.isInteger(v), `${path} must be an integer`).toBe(true);
        expect(v >= 0 && v <= 3, `${path} must be 0..3`).toBe(true);
      } else if (typeof v === 'string') {
        expect(bad.test(v), `${path}: "${v}"`).toBe(false);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          expect(bad.test(k), `key ${path}.${k}`).toBe(false);
          if (k === 'offer_id') continue;
          walk(x, `${path}.${k}`);
        }
      }
    };
    for (let n = 0; n < 500; n++) {
      const { b, a, o, price } = randomCase(r);
      const c = computeFit(b, { offer: o, article: a, price_minor: price }, NOW);
      expect(Object.keys(c).sort()).toEqual(['band', 'dimensions', 'offer_id']);
      walk(c.dimensions, 'dimensions');
      expect(['strong', 'good', 'partial', null]).toContain(c.band);
    }
  });

  it('every card parses against the FitCard contract', async () => {
    const { FitCardSchema } = await import('@umsbx/contracts');
    const r = rng(16);
    for (let n = 0; n < 200; n++) {
      const { b, a, o, price } = randomCase(r);
      FitCardSchema.parse(computeFit(b, { offer: o, article: a, price_minor: price }, NOW));
    }
  });
});
