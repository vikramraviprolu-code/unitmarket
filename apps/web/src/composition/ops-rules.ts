// BR-6: the reads of the operator "Business rules" pages and of the CSV export. Every read is for an operator and
// answers null for anyone else, so a page that forgot its own check still shows nothing. Reading is all it does:
// the only write path is POST /api/ops/rules (BR-2), which the form calls through lib/client-api.ts. No read here
// writes a row, so none adds a journal event; the export route's audit row is the one withRoute writes.
// The start time offered by the form and the "live now" test for the index come from the database clock: the web
// layer has no injected clock of its own, and both are only defaults the domain checks again when a row is added.
import { IdSchema, RULES_REGISTRY, RULE_KEYS } from '@umsbx/contracts';
import type { Actor, EnvironmentLabel } from '@umsbx/contracts';
import { app, csvLine } from '../server/access';
import { RULE_HINT, RULE_LABEL, SCOPE_LABEL } from '../lib/ops-rules-copy';
import type { WritableScope } from '../lib/ops-rules-copy';
import {
  WRITABLE_SCOPES,
  explainView,
  historyRowView,
  parseRulesHistoryQuery,
  rulesIndexView,
} from '../lib/ops-rules-view';
import type {
  ExplainView,
  HistoryFilter,
  HistoryRowView,
  RawQuery,
  RuleIndexRow,
} from '../lib/ops-rules-view';

export { parseRulesHistoryQuery } from '../lib/ops-rules-view';

type OperatorActor = Extract<Actor, { kind: 'operator' }>;
const asOperator = (actor: Actor | null): OperatorActor | null =>
  actor !== null && actor.kind === 'operator' ? actor : null;

/** The screen shows 200 rows (the BR-2 default); the CSV holds 5000 (the BR-2 maximum). */
const SCREEN_ROWS = 200;
const EXPORT_ROWS = 5000;
export const EXPORT_FILENAME = 'business-rules-history.csv';

async function dbNow(): Promise<string> {
  const r = await (
    await app()
  ).db.query<{ t: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`,
  );
  return r.rows[0]!.t;
}

export interface RulesIndexRead {
  environment: EnvironmentLabel;
  mfa: boolean;
  rows: RuleIndexRow[];
}

export async function readRulesIndex(actor: Actor): Promise<RulesIndexRead | null> {
  const op = asOperator(actor);
  if (op === null) return null;
  const a = await app();
  const now = await dbNow();
  // Platform rows only: neither id can match a seller or buyer row, so the sale-shaped read returns the
  // rows live now for the platform.
  const platform = await a.engine.rules.activeRows(
    { seller_id: '', buyer_id: '', category: null },
    now,
  );
  const history = await a.engine.opsRules.history(undefined, EXPORT_ROWS);
  const mfa = op.mfa === true;
  return { environment: a.environment, mfa, rows: rulesIndexView({ now, platform, history, mfa }) };
}

export interface NewRulePageRead {
  environment: EnvironmentLabel;
  mfa: boolean;
  /** A single-use Idempotency-Key made on the server (CO-8): a second click replays, it cannot add twice. */
  key: string;
  /** A start time to offer, from the database clock. */
  default_from: string;
  rules: {
    key: string;
    label: string;
    hint: string;
    unit: 'days';
    min: number;
    max: number;
    scopes: { kind: WritableScope; label: string }[];
  }[];
}

export async function readNewRulePage(actor: Actor): Promise<NewRulePageRead | null> {
  const op = asOperator(actor);
  if (op === null) return null;
  const a = await app();
  return {
    environment: a.environment,
    mfa: op.mfa === true,
    key: a.engine.newKey(),
    default_from: await dbNow(),
    rules: RULE_KEYS.map((key) => {
      const def = RULES_REGISTRY[key];
      return {
        key,
        label: RULE_LABEL[key],
        hint: RULE_HINT[key],
        unit: def.unit,
        min: def.min,
        max: def.max,
        scopes: WRITABLE_SCOPES.filter((s) => def.scopes.includes(s)).map((kind) => ({
          kind,
          label: SCOPE_LABEL[kind],
        })),
      };
    }),
  };
}

export interface RulesHistoryRead {
  environment: EnvironmentLabel;
  mfa: boolean;
  /** The filters that were understood. The operator filter is dropped for a session without the code. */
  filter: HistoryFilter;
  /** Names of query values that were refused. Any entry means no rows are listed. */
  invalid: string[];
  rows: HistoryRowView[];
  /** More than 200 rows match: the screen shows the newest 200. */
  capped: boolean;
}

export async function readRulesHistory(
  actor: Actor,
  raw: RawQuery,
): Promise<RulesHistoryRead | null> {
  const op = asOperator(actor);
  if (op === null) return null;
  const a = await app();
  const mfa = op.mfa === true;
  const { filter, invalid } = parseRulesHistoryQuery(raw);
  if (!mfa) delete filter.operator;
  const base = { environment: a.environment, mfa, filter, invalid };
  if (invalid.length > 0) return { ...base, filter: {}, rows: [], capped: false };
  const { operator, ...stored } = filter;
  // The operator is not a column the store filters on: read wide, filter here, then cut to the screen.
  const rows = await a.engine.opsRules.history(
    stored,
    operator === undefined ? SCREEN_ROWS + 1 : EXPORT_ROWS,
  );
  const mine = operator === undefined ? rows : rows.filter((r) => r.set_by === operator);
  return {
    ...base,
    rows: mine.slice(0, SCREEN_ROWS).map((r) => historyRowView(r, mfa)),
    capped: mine.length > SCREEN_ROWS,
  };
}

export type ExplainRead = { kind: 'blank' } | { kind: 'refused' } | ExplainView;

/**
 * The terms of one order, by its id or by the order reference the operator pages show. `order` is the raw query value: undefined is the blank page; anything that is not one
 * string that passes IdSchema, or is not an order, is `refused` (the page answers 404). The id never reaches a
 * query unless it passed.
 */
export async function readExplain(actor: Actor, order: unknown): Promise<ExplainRead | null> {
  if (asOperator(actor) === null) return null;
  if (order === undefined) return { kind: 'blank' };
  if (typeof order !== 'string') return { kind: 'refused' };
  const id = IdSchema.safeParse(order);
  if (!id.success) return { kind: 'refused' };
  const r = await (
    await app()
  ).db.query<{ id: string; snapshot: unknown }>(
    `SELECT o.id, a.snapshot FROM orders o JOIN approvals a ON a.id = o.approval_id
      WHERE o.id = $1 OR o.order_ref = $1`,
    [id.data],
  );
  const row = r.rows[0];
  if (row === undefined) return { kind: 'refused' };
  return explainView(row.id, row.snapshot);
}

const HEADER = [
  'rule_key',
  'scope_kind',
  'scope_id',
  'value',
  'effective_from',
  'effective_until',
  'set_by',
  'reason',
  'created_at',
] as const;

/**
 * The whole history as CSV text: newest first, at most 5000 rows, `truncated` when more are stored. Cells that
 * start like a formula are made safe by the shared csvCell. `set_by` is empty for a session without the code.
 */
export async function readRulesExport(
  actor: Actor,
): Promise<{ filename: string; csv: string; truncated: boolean } | null> {
  const op = asOperator(actor);
  if (op === null) return null;
  const a = await app();
  const mfa = op.mfa === true;
  const rows = await a.engine.opsRules.history(undefined, EXPORT_ROWS);
  const total = Number(
    (await a.db.query<{ n: string | number }>('SELECT count(*) AS n FROM rule_settings')).rows[0]!
      .n,
  );
  const lines = rows.map((r) =>
    csvLine([
      r.rule_key,
      r.scope_kind,
      r.scope_id,
      r.value,
      r.effective_from,
      r.effective_until,
      mfa ? r.set_by : null,
      r.reason,
      r.created_at,
    ]),
  );
  return {
    filename: EXPORT_FILENAME,
    csv: csvLine([...HEADER]) + lines.join(''),
    truncated: total > rows.length,
  };
}
