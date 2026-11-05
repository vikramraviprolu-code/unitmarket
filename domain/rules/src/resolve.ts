// BR-1: resolveTerms, the pure function that picks the value of each rule for one sale.
// No clock, database or environment: `now` is an ISO string. Precedence (design section 6):
//   1. Keep rows active at `now` (effective_from <= now < effective_until). Agreement rows are
//      ignored until the agreements lane.
//   2. Seller side: seller scope over category over platform. Buyer side: buyer over platform.
//      Inside one scope: latest effective_from, then latest created_at, then the larger id.
//   3. If both sides were set by a non-platform row, merge by the key's strategy (max, min,
//      seller_wins). Otherwise the one value that was set, or the default, applies. A platform row
//      stands for both sides, so it never merges with itself.
//      Exception, the ceiling (gate decision G1): for a key whose strategy is `min`
//      (mandate.max_days) an active platform row is a ceiling, so it joins the merge with a
//      buyer-scope row and the lower value wins, with its own source. The `max` and `seller_wins`
//      keys are unchanged: platform 7 + seller 3 still gives 3. With no platform row, a lone buyer
//      row applies as it is (the registry default is not a row).
//   4. Link: access.window = max(access.window, refund.request_window).
//   5. Every value inside its safe range, else rules_invalid. Fail closed.
import { RULES_REGISTRY, RULE_KEYS, err, isRuleValueInRange, ok } from '@umsbx/contracts';
import type {
  ResolvedTerms,
  Result,
  RuleKey,
  RuleScopeKind,
  RuleSettingRow,
  RulesError,
} from '@umsbx/contracts';
import { termsDigest } from './digest';

export interface RulesContext {
  /** `publishers.id` of the seller. */
  readonly seller_id: string;
  /** `buyers.id` of the buyer. */
  readonly buyer_id: string;
  readonly category: string | null;
}

interface Chosen {
  readonly value: number;
  readonly scope: RuleScopeKind;
  readonly source: string;
}

const invalid = (key?: RuleKey): Result<never, RulesError> =>
  err(key === undefined ? { code: 'rules_invalid' } : { code: 'rules_invalid', key });

/** Newest first: effective_from, then created_at (instants, not text), then the larger id. */
function newestFirst(a: RuleSettingRow, b: RuleSettingRow): number {
  const byFrom = Date.parse(b.effective_from) - Date.parse(a.effective_from);
  if (byFrom !== 0) return byFrom;
  const byCreated = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function sourceOf(row: RuleSettingRow): string {
  return row.scope_kind === 'platform'
    ? `platform:${row.id}`
    : `${row.scope_kind}:${String(row.scope_id)}@${row.id}`;
}

/** The newest active row of one scope, or null. */
function newest(rows: readonly RuleSettingRow[], kind: RuleScopeKind, scopeId: string | null) {
  if (kind !== 'platform' && scopeId === null) return null;
  const hits = rows.filter(
    (r) => r.scope_kind === kind && (kind === 'platform' || r.scope_id === scopeId),
  );
  if (hits.length === 0) return null;
  return [...hits].sort(newestFirst)[0] ?? null;
}

const toChosen = (row: RuleSettingRow | null): Chosen | null =>
  row === null ? null : { value: row.value, scope: row.scope_kind, source: sourceOf(row) };

function pickKey(key: RuleKey, ctx: RulesContext, active: readonly RuleSettingRow[], t: number) {
  const def = RULES_REGISTRY[key];
  // Only rows for this key, at a scope the key allows, and live at `now`. A stored row at a scope
  // the key does not allow (BR-2 refuses to write one) is not obeyed.
  const rows = active.filter(
    (r) =>
      r.rule_key === key &&
      r.scope_kind !== 'agreement' &&
      def.scopes.includes(r.scope_kind) &&
      Date.parse(r.effective_from) <= t &&
      (r.effective_until === null || t < Date.parse(r.effective_until)),
  );
  const platform = toChosen(newest(rows, 'platform', null));
  const sellerSide =
    toChosen(newest(rows, 'seller', ctx.seller_id)) ??
    toChosen(newest(rows, 'category', ctx.category)) ??
    platform;
  const buyerSide = toChosen(newest(rows, 'buyer', ctx.buyer_id)) ?? platform;
  return { sellerSide, buyerSide };
}

function merge(key: RuleKey, seller: Chosen, buyer: Chosen): Chosen {
  switch (RULES_REGISTRY[key].merge) {
    case 'max':
      return buyer.value > seller.value ? buyer : seller;
    case 'min':
      return buyer.value < seller.value ? buyer : seller;
    case 'seller_wins':
      return seller;
  }
}

export function resolveTerms(
  ctx: RulesContext,
  rows: readonly RuleSettingRow[],
  now: string,
): Result<ResolvedTerms, RulesError> {
  const t = Date.parse(now);
  if (Number.isNaN(t)) return invalid();
  // An unreadable stored time would make a comparison silently false: refuse instead of guessing.
  for (const r of rows) {
    if (
      Number.isNaN(Date.parse(r.effective_from)) ||
      Number.isNaN(Date.parse(r.created_at)) ||
      (r.effective_until !== null && Number.isNaN(Date.parse(r.effective_until)))
    ) {
      return invalid(r.rule_key);
    }
  }

  const values: Record<string, number> = {};
  const sources: Record<string, string> = {};

  for (const key of RULE_KEYS) {
    const { sellerSide, buyerSide } = pickKey(key, ctx, rows, t);
    // A winner out of range fails even if the merge would hide it.
    for (const side of [sellerSide, buyerSide]) {
      if (side !== null && !isRuleValueInRange(key, side.value)) return invalid(key);
    }
    // Ceiling: for a `min` key the platform row on the seller side still takes part when the buyer
    // set a row of their own; otherwise a platform row never merges.
    const platformIsCeiling = RULES_REGISTRY[key].merge === 'min';
    const bothSet =
      sellerSide !== null &&
      buyerSide !== null &&
      buyerSide.scope !== 'platform' &&
      (sellerSide.scope !== 'platform' || platformIsCeiling);
    const chosen =
      bothSet && sellerSide !== null && buyerSide !== null
        ? merge(key, sellerSide, buyerSide)
        : // One side set it, or only the platform did. A specific scope beats the platform row.
          sellerSide !== null && sellerSide.scope !== 'platform'
          ? sellerSide
          : buyerSide !== null && buyerSide.scope !== 'platform'
            ? buyerSide
            : sellerSide;
    values[key] = chosen === null ? RULES_REGISTRY[key].default : chosen.value;
    sources[key] = chosen === null ? 'default' : chosen.source;
  }

  // Link rule: a buyer must still have the content while a refund can be requested.
  const refundDays = values['refund.request_window'] as number;
  if ((values['access.window'] as number) < refundDays) {
    values['access.window'] = refundDays;
    sources['access.window'] = 'linked:refund.request_window';
  }

  for (const key of RULE_KEYS) {
    if (!isRuleValueInRange(key, values[key] as number)) return invalid(key);
  }

  return ok({
    rules_version: '1',
    values: {
      'refund.request_window': values['refund.request_window'] as number,
      'access.window': values['access.window'] as number,
      'mandate.max_days': values['mandate.max_days'] as number,
    },
    sources: {
      'refund.request_window': sources['refund.request_window'] as string,
      'access.window': sources['access.window'] as string,
      'mandate.max_days': sources['mandate.max_days'] as string,
    },
    digest: termsDigest(values),
  });
}
