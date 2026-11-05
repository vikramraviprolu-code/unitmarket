// BR-1: the registry of configurable business rules and the shapes around it. Shapes and a table
// only: the pure resolver is in domain/rules. Nothing here reads a clock, a database or the
// environment, and nothing in the product reads it yet (BR-2, BR-3 and BR-4 do).
// Design: docs/business-rules/configurable-rules-design.md sections 3, 5 and 6. Decision: D-096.
import { z } from 'zod';
import { IdSchema, IsoUtcSchema, Sha256HexSchema } from './primitives';

/**
 * Where a setting may apply. `seller` keys on `publishers.id` and `buyer` on `buyers.id`.
 * `agreement` rows are stored but ignored by the resolver until the agreements lane.
 */
export const RuleScopeKindSchema = z.enum(['platform', 'category', 'seller', 'buyer', 'agreement']);
export type RuleScopeKind = z.infer<typeof RuleScopeKindSchema>;

/** Slice keys only. The other keys in design section 3 are later lanes. */
export const RULE_KEYS = ['refund.request_window', 'access.window', 'mandate.max_days'] as const;
export const RuleKeySchema = z.enum(RULE_KEYS);
export type RuleKey = z.infer<typeof RuleKeySchema>;

/** How the seller side and the buyer side combine when both set the key at seller or buyer scope. */
export type RuleMerge = 'max' | 'min' | 'seller_wins';

export interface RuleDefinition {
  readonly key: RuleKey;
  /** Where the rule came from: a business-rules reference id or a decision id. */
  readonly ref: string;
  readonly unit: 'days';
  readonly default: number;
  /** Safe range, both ends included. */
  readonly min: number;
  readonly max: number;
  readonly scopes: readonly RuleScopeKind[];
  readonly merge: RuleMerge;
  /** Tier A: one operator with the authenticator code. Tier B (money) is not in this slice. */
  readonly tier: 'A' | 'B';
}

const def = (d: RuleDefinition): RuleDefinition =>
  Object.freeze({ ...d, scopes: Object.freeze([...d.scopes]) });

export const RULES_REGISTRY: Readonly<Record<RuleKey, RuleDefinition>> = Object.freeze({
  // D-096: seven days, configurable from 0 to 30. Counted from the start of the access window.
  'refund.request_window': def({
    key: 'refund.request_window',
    ref: 'BR-REF-13, D-096',
    unit: 'days',
    default: 7,
    min: 0,
    max: 30,
    scopes: ['platform', 'category', 'seller', 'buyer', 'agreement'],
    merge: 'max',
    tier: 'A',
  }),
  // Linked: the resolver raises it to at least the refund window (D-096 (1)).
  'access.window': def({
    key: 'access.window',
    ref: 'BR-ACC-1',
    unit: 'days',
    default: 5,
    min: 1,
    max: 30,
    scopes: ['platform', 'category', 'seller'],
    merge: 'seller_wins',
    tier: 'A',
  }),
  'mandate.max_days': def({
    key: 'mandate.max_days',
    ref: 'BR-MAN-2',
    unit: 'days',
    default: 90,
    min: 1,
    max: 90,
    scopes: ['platform', 'buyer'],
    merge: 'min',
    tier: 'A',
  }),
});

/** True when `value` is a whole number inside the key's safe range. */
export function isRuleValueInRange(key: RuleKey, value: number): boolean {
  const d = RULES_REGISTRY[key];
  return Number.isInteger(value) && value >= d.min && value <= d.max;
}

/**
 * One stored override. The range of `value` is checked when a row is written (BR-2) and again by
 * the resolver, which fails closed; the shape here accepts any integer so the resolver can be
 * tested with a bad stored row.
 */
export const RuleSettingRowSchema = z
  .object({
    id: IdSchema,
    rule_key: RuleKeySchema,
    scope_kind: RuleScopeKindSchema,
    /** Null only for platform. */
    scope_id: IdSchema.nullable(),
    value: z.number().int(),
    effective_from: IsoUtcSchema,
    effective_until: IsoUtcSchema.nullable(),
    set_by: IdSchema,
    reason: z.string().min(3).max(200),
    approved_by: IdSchema.nullable(),
    created_at: IsoUtcSchema,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.scope_kind === 'platform' ? row.scope_id !== null : row.scope_id === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope_id'],
        message: 'scope_id is null for platform and required for every other scope',
      });
    }
    if (!RULES_REGISTRY[row.rule_key].scopes.includes(row.scope_kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope_kind'],
        message: `${row.rule_key} cannot be set at ${row.scope_kind} scope`,
      });
    }
  });
export type RuleSettingRow = z.infer<typeof RuleSettingRowSchema>;

const ValuesSchema = z
  .object({
    'refund.request_window': z.number().int(),
    'access.window': z.number().int(),
    'mandate.max_days': z.number().int(),
  })
  .strict();

const SourcesSchema = z
  .object({
    'refund.request_window': z.string().min(1).max(500),
    'access.window': z.string().min(1).max(500),
    'mandate.max_days': z.string().min(1).max(500),
  })
  .strict();

/**
 * What the resolver returns for one sale. The version field is `rules_version`, not
 * `terms_version`: that name already means the offer terms on `SnapshotItemSchema`.
 * `sources[key]` is `default`, `linked:<key>`, or `<scope>:<id>@<row id>` (`platform:<row id>`).
 * `digest` is the sha256 of the canonical JSON of `values`.
 */
export const ResolvedTermsSchema = z
  .object({
    rules_version: z.literal('1'),
    values: ValuesSchema,
    sources: SourcesSchema,
    digest: Sha256HexSchema,
  })
  .strict();
export type ResolvedTerms = z.infer<typeof ResolvedTermsSchema>;

/** The resolver's one failure: a value outside its safe range, or an unreadable time. */
export const RulesErrorSchema = z
  .object({ code: z.literal('rules_invalid'), key: RuleKeySchema.optional() })
  .strict();
export type RulesError = z.infer<typeof RulesErrorSchema>;
