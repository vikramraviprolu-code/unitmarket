// INT-CTL / CTL.4: the registry of API groups an operator can switch off for partners. A const list, so the SQL
// CHECK of migration 0026, the exposure reader, the routes and the screen read one set of names. REST groups are
// the first eight (each one holds the /api/v1 prefixes of GROUP_OF_PATH); the six `mcp:<tool>` entries gate one MCP
// tool each and are independent of the REST groups (F7).
export const API_GROUPS = [
  'catalogue',
  'orders',
  'library',
  'mandates',
  'webhooks',
  'seller',
  'ops',
  'mcp',
  'mcp:search_catalogue',
  'mcp:get_offer',
  'mcp:propose_pack',
  'mcp:open_unit',
  'mcp:check_budget',
  'mcp:buy_unit',
] as const;
export type ApiGroup = (typeof API_GROUPS)[number];

/** The reason an operator gives for a change, from a closed list: a switch or an exposure row never holds free text. */
export const EXPOSURE_REASON_CODES = [
  'incident',
  'partner_request',
  'maintenance',
  'other',
] as const;
export type ExposureReasonCode = (typeof EXPOSURE_REASON_CODES)[number];

/** The stamp of every row a migration seeds (restore recognises a fresh database by it). */
export const SEED_EPOCH = '1970-01-01T00:00:00Z';

/**
 * The first path segment under /api/v1 of every `auth: 'apikey'` route, and the group it belongs to (F1).
 * `api-keys` (owner sessions) and `status` (public) are not apikey routes and are never gated. A prefix added to an
 * apikey route joins this table; the golden test fails on any apikey route whose prefix is missing.
 */
export const GROUP_OF_PATH: Readonly<Record<string, ApiGroup>> = {
  catalogue: 'catalogue',
  briefs: 'catalogue',
  offers: 'catalogue',
  orders: 'orders',
  quotes: 'orders',
  approvals: 'orders',
  library: 'library',
  mandates: 'mandates',
  'webhook-subscriptions': 'webhooks',
  seller: 'seller',
  ops: 'ops',
  mcp: 'mcp',
};

const V1 = '/api/v1/';

/** The group of a route path, or null when the path is not under /api/v1 or its prefix is not in the table. */
export function groupOfPath(path: string): ApiGroup | null {
  if (!path.startsWith(V1)) return null;
  const prefix = path.slice(V1.length).split('/')[0] ?? '';
  return Object.prototype.hasOwnProperty.call(GROUP_OF_PATH, prefix)
    ? (GROUP_OF_PATH[prefix] ?? null)
    : null;
}

export function isApiGroup(v: unknown): v is ApiGroup {
  return typeof v === 'string' && (API_GROUPS as readonly string[]).includes(v);
}

/** Reads whether a group is open to partners. A failed read answers false for every group (fail closed). */
export interface ExposureReader {
  isEnabled(group: ApiGroup): Promise<boolean>;
}
