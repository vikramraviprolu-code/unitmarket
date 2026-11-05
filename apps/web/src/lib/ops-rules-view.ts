// BR-6: the view models of the operator "Business rules" pages. Pure: no server module, no clock, no identity
// beyond the `mfa` flag the caller passes. The pages show what these functions return and the tests pin them.
// Identity rule: the operator who made a change is shown only to a session that signed in with the
// authenticator code, as on the Activity page; without it `by` is null and the page says so in words.
import {
  ApprovalSnapshotSchema,
  RULES_REGISTRY,
  RULE_KEYS,
  RuleKeySchema,
  RuleScopeKindSchema,
} from '@umsbx/contracts';
import type { RuleKey, RuleScopeKind, RuleSettingRow } from '@umsbx/contracts';
import { OLD_ORDER_LINE, RULE_LABEL, SCOPE_LABEL, sourceText } from './ops-rules-copy';
import type { WritableScope } from './ops-rules-copy';

/** The scope kinds an operator can set today: `agreement` is stored for a later lane and is not offered. */
export const WRITABLE_SCOPES: readonly WritableScope[] = [
  'platform',
  'category',
  'seller',
  'buyer',
];

const writableScopes = (key: RuleKey): WritableScope[] =>
  WRITABLE_SCOPES.filter((s) => RULES_REGISTRY[key].scopes.includes(s));

const isLive = (r: RuleSettingRow, now: string): boolean =>
  Date.parse(r.effective_from) <= Date.parse(now) &&
  (r.effective_until === null || Date.parse(r.effective_until) > Date.parse(now));

export interface RuleIndexRow {
  key: RuleKey;
  label: string;
  unit: 'days';
  min: number;
  max: number;
  scopes: WritableScope[];
  platform_value: number;
  platform_source: 'default' | 'setting';
  /** Sellers and buyers that have a setting live now (one count per seller or buyer, not per row). */
  seller_overrides: number;
  buyer_overrides: number;
  last_change: { at: string; by: string | null; reason: string } | null;
}

/**
 * One row per registry key. `platform` is the platform rows live at `now`, newest start first (what
 * engine.rules.activeRows returns); `history` is every stored row, newest first (engine.opsRules.history).
 */
export function rulesIndexView(i: {
  now: string;
  platform: readonly RuleSettingRow[];
  history: readonly RuleSettingRow[];
  mfa: boolean;
}): RuleIndexRow[] {
  return RULE_KEYS.map((key) => {
    const def = RULES_REGISTRY[key];
    const platform = i.platform.find((r) => r.rule_key === key && r.scope_kind === 'platform');
    const live = i.history.filter((r) => r.rule_key === key && isLive(r, i.now));
    const distinct = (kind: 'seller' | 'buyer'): number =>
      new Set(live.filter((r) => r.scope_kind === kind).map((r) => r.scope_id)).size;
    const last = i.history.find((r) => r.rule_key === key);
    return {
      key,
      label: RULE_LABEL[key],
      unit: def.unit,
      min: def.min,
      max: def.max,
      scopes: writableScopes(key),
      platform_value: platform === undefined ? def.default : platform.value,
      platform_source: platform === undefined ? 'default' : 'setting',
      seller_overrides: distinct('seller'),
      buyer_overrides: distinct('buyer'),
      last_change:
        last === undefined
          ? null
          : { at: last.created_at, by: i.mfa ? last.set_by : null, reason: last.reason },
    };
  });
}

export interface HistoryRowView {
  id: string;
  key: RuleKey;
  label: string;
  scope_kind: RuleScopeKind;
  scope_label: string;
  scope_id: string | null;
  value: number;
  from: string;
  until: string | null;
  by: string | null;
  reason: string;
  at: string;
}

export function historyRowView(r: RuleSettingRow, mfa: boolean): HistoryRowView {
  return {
    id: r.id,
    key: r.rule_key,
    label: RULE_LABEL[r.rule_key],
    scope_kind: r.scope_kind,
    scope_label: r.scope_kind === 'agreement' ? 'An agreement' : SCOPE_LABEL[r.scope_kind],
    scope_id: r.scope_id,
    value: r.value,
    from: r.effective_from,
    until: r.effective_until,
    by: mfa ? r.set_by : null,
    reason: r.reason,
    at: r.created_at,
  };
}

export interface HistoryFilter {
  rule_key?: RuleKey;
  scope_kind?: RuleScopeKind;
  scope_id?: string;
  operator?: string;
}
export type RawQuery = Readonly<Record<string, string | string[] | undefined>>;

// A scope id or an operator id is a plain token. Stricter than IdSchema on purpose: a filter value never needs a
// space, a quote or a control character, so none is accepted.
const TOKEN = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * The filters of the history page from its query string. A value that is not a registry value or a plain token
 * is named in `invalid` and left out of `filter`; the page then lists nothing and says so. Unknown keys are
 * ignored. An empty value is the same as no value (the form sends empty fields).
 */
export function parseRulesHistoryQuery(raw: RawQuery): {
  filter: HistoryFilter;
  invalid: string[];
} {
  const filter: HistoryFilter = {};
  const invalid: string[] = [];
  const take = (name: 'rule_key' | 'scope_kind' | 'scope_id' | 'operator'): void => {
    const v = raw[name];
    if (v === undefined || v === '') return;
    if (typeof v !== 'string') {
      invalid.push(name);
      return;
    }
    if (name === 'rule_key') {
      const p = RuleKeySchema.safeParse(v);
      if (p.success) filter.rule_key = p.data;
      else invalid.push(name);
    } else if (name === 'scope_kind') {
      const p = RuleScopeKindSchema.safeParse(v);
      if (p.success) filter.scope_kind = p.data;
      else invalid.push(name);
    } else if (TOKEN.test(v)) {
      filter[name] = v;
    } else {
      invalid.push(name);
    }
  };
  take('rule_key');
  take('scope_kind');
  take('scope_id');
  take('operator');
  return { filter, invalid };
}

export interface ExplainRow {
  key: RuleKey;
  label: string;
  value: number;
  unit: 'days';
  source: string;
}
export type ExplainView =
  | { kind: 'terms'; order_id: string; rules_version: string; digest: string; rows: ExplainRow[] }
  | { kind: 'old'; order_id: string; line: string }
  | { kind: 'unreadable'; order_id: string };

/**
 * The terms an order was approved under, from its stored approval snapshot. Version 1 has none (approved before
 * BR-3): it says so. A snapshot the schema does not accept is reported as unreadable, never guessed at.
 */
export function explainView(order_id: string, snapshot: unknown): ExplainView {
  const parsed = ApprovalSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return { kind: 'unreadable', order_id };
  if (parsed.data.snapshot_version === '1') return { kind: 'old', order_id, line: OLD_ORDER_LINE };
  const t = parsed.data.terms;
  return {
    kind: 'terms',
    order_id,
    rules_version: t.rules_version,
    digest: t.digest,
    rows: RULE_KEYS.map((key) => ({
      key,
      label: RULE_LABEL[key],
      value: t.values[key],
      unit: RULES_REGISTRY[key].unit,
      source: sourceText(t.sources[key]),
    })),
  };
}
