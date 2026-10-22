// One pure function per fit dimension. Every level comes from a stated rule over facts, and every
// evidence string is built from the same facts (architecture 9.11). A missing input gives level null,
// never a guess. No percentage, no probability, no weighted score exists anywhere in this file.
// Term matching idea adapted from AIC_Hackathon_UnitMarket packages/core/catalogue/search.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90 (whole-word term overlap). Owned by SBX.
import type { AccessOption, ArticleFacts, Brief, FitDimension, Offer } from '@umsbx/contracts';

export type Level = FitDimension['level'];
const DAY_MS = 86_400_000;

type Dim<K extends FitDimension['key']> = FitDimension & { key: K };

// Lowercase whole words (letters and digits, any script).
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);

export function topicDimension(brief: Brief, article: ArticleFacts): Dim<'topic'> {
  const base = { key: 'topic', label: 'Topic', basis: 'keyword_overlap' } as const;
  const terms = [...new Set(brief.terms.flatMap(words))];
  if (terms.length === 0) return { ...base, level: null, evidence: 'No topic terms given' };
  const have = new Set(words(`${article.title} ${article.abstract} ${article.topics.join(' ')}`));
  const k = terms.filter((t) => have.has(t)).length;
  const n = terms.length;
  // Integer arithmetic: k/n <= 1/3 is 3k <= n; k/n <= 2/3 is 3k <= 2n.
  const level: Level = k === 0 ? 0 : 3 * k <= n ? 1 : 3 * k <= 2 * n ? 2 : 3;
  return { ...base, level, evidence: `${k} of ${n} terms` };
}

const EXPONENT: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, BHD: 3, KWD: 3 };
const SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };

// Minor units to a display amount, using the currency's exponent (2 unless listed above).
// `minor_units` (the corridor's exponent) wins over the table when the caller knows it (review 4 L3).
export function formatMoney(currency: string, minor: number, minor_units?: number): string {
  const exp = minor_units ?? EXPONENT[currency] ?? 2;
  const unit = 10 ** exp;
  const whole = Math.floor(minor / unit);
  const frac = minor % unit;
  const amount = exp === 0 ? String(whole) : `${whole}.${String(frac).padStart(exp, '0')}`;
  const symbol = SYMBOL[currency];
  return symbol ? `${symbol}${amount}` : `${currency} ${amount}`;
}

export function budgetDimension(
  brief: Brief,
  offer: Offer,
  price_minor: number,
  minor_units?: number,
): Dim<'budget'> {
  const base = { key: 'budget', label: 'Budget', basis: 'price_vs_ceiling' } as const;
  const c = brief.ceiling;
  if (c === null) return { ...base, level: null, evidence: 'No ceiling given' };
  if (c.currency !== offer.currency) {
    return { ...base, level: null, evidence: 'Ceiling is in another currency' };
  }
  const evidence = `${formatMoney(offer.currency, price_minor, minor_units)} of your ${formatMoney(c.currency, c.minor, minor_units)}`;
  const level: Level =
    price_minor * 2 <= c.minor
      ? 3
      : price_minor * 4 <= c.minor * 3
        ? 2
        : price_minor <= c.minor
          ? 1
          : 0;
  return { ...base, level, evidence };
}

const OPTION_NAME: Record<AccessOption, string> = {
  keep_retrieve: 'Download and keep',
  online_read: 'Online reading',
};

export function accessDimension(brief: Brief, offer: Offer): Dim<'access'> {
  const base = { key: 'access', label: 'Access', basis: 'option_offered' } as const;
  if (brief.option === null)
    return { ...base, level: null, evidence: 'No access option asked for' };
  const offered = offer.options.some((o) => o.option === brief.option);
  return offered
    ? { ...base, level: 3, evidence: `${OPTION_NAME[brief.option]} offered` }
    : { ...base, level: 0, evidence: `${OPTION_NAME[brief.option]} not offered` };
}

// Review 4 L2: a language tag is bounded (35 characters, the BCP 47 maximum for common tags) and
// normalised (trim, lower case, '_' as '-'); anything that is not tag-shaped counts as unknown, so a
// long or hostile brief value never reaches the evidence text.
const LANG_TAG = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;
export function normaliseLanguage(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const t = raw.trim().toLowerCase().replace(/_/g, '-');
  return t.length <= 35 && LANG_TAG.test(t) ? t : '';
}

export function languageDimension(brief: Brief, article: ArticleFacts): Dim<'language'> {
  const base = { key: 'language', label: 'Language', basis: 'language_equal' } as const;
  const want = normaliseLanguage(brief.language);
  const have = normaliseLanguage(article.language);
  if (want === '' || have === '') return { ...base, level: null, evidence: 'Language not known' };
  return want === have
    ? { ...base, level: 3, evidence: `Article is in ${have}` }
    : { ...base, level: 0, evidence: `Article is in ${have}, you asked for ${want}` };
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} old`;

export function recencyDimension(article: ArticleFacts, now: Date): Dim<'recency'> {
  const base = { key: 'recency', label: 'Recency', basis: 'publish_date' } as const;
  const published = Date.parse(article.published_at);
  const age = now.getTime() - published;
  if (Number.isNaN(published) || age < 0) {
    return { ...base, level: null, evidence: 'Publish date not usable' };
  }
  const days = Math.floor(age / DAY_MS);
  const level: Level = days < 30 ? 3 : days < 365 ? 2 : 1;
  const evidence =
    days < 30
      ? plural(days, 'day')
      : days < 365
        ? plural(Math.floor(days / 30), 'month')
        : plural(Math.floor(days / 365), 'year');
  return { ...base, level, evidence };
}
