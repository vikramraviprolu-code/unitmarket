// Route inventory (SOP 5): static reading of the `routeMeta` literal that every route.ts exports.
// Pure and self-contained so scripts/route-inventory.mjs can load it directly (type imports only).
import type { AuthRule, RouteMeta } from './route';

export const AUTH_RULES: readonly AuthRule[] = [
  'public',
  'buyer',
  'publisher',
  'operator',
  'webhook',
];

export interface InventoryEntry {
  file: string;
  meta: Partial<RouteMeta> | null;
  problems: string[];
}

// `app/(group)/api/orders/[id]/route.ts` -> `/api/orders/[id]`
export function pathFromFile(relativeToApp: string): string {
  const segs = relativeToApp
    .split('/')
    .slice(0, -1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'));
  return '/' + segs.join('/');
}

function literal(source: string): string | null {
  const m = /export\s+const\s+routeMeta\b[^=]*=\s*\{/.exec(source);
  if (m === null) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(m.index + m[0].length - 1, i + 1);
  }
  return null;
}

function field(body: string, name: string): string | null {
  const m = new RegExp(
    `(?:^|[\\s,{])${name}\\s*:\\s*('[^']*'|"[^"]*"|true|false|null|\\d[\\d_]*|\\{[^}]*\\})`,
  ).exec(body);
  return m?.[1] ?? null;
}

const str = (v: string | null): string | undefined =>
  v !== null && /^['"]/.test(v) ? v.slice(1, -1) : undefined;
const num = (v: string | null): number | undefined =>
  v !== null && /^\d/.test(v) ? Number(v.replace(/_/g, '')) : undefined;
const bool = (v: string | null): boolean | undefined =>
  v === 'true' ? true : v === 'false' ? false : undefined;

export function parseRouteMeta(source: string): Partial<RouteMeta> | null {
  const body = literal(source);
  if (body === null) return null;
  const meta: Record<string, unknown> = {};
  for (const k of ['path', 'method', 'auth', 'risk']) {
    const v = str(field(body, k));
    if (v !== undefined) meta[k] = v;
  }
  for (const k of ['csrf', 'idempotent']) {
    const v = bool(field(body, k));
    if (v !== undefined) meta[k] = v;
  }
  const mb = num(field(body, 'max_body_bytes'));
  if (mb !== undefined) meta.max_body_bytes = mb;
  const rate = field(body, 'rate');
  if (rate === 'null') meta.rate = null;
  else if (rate !== null && rate.startsWith('{')) {
    const name = str(field(rate, 'name'));
    const per = str(field(rate, 'per'));
    const limit = num(field(rate, 'limit'));
    const window_ms = num(field(rate, 'window_ms'));
    if (
      name !== undefined &&
      (per === 'ip' || per === 'actor') &&
      limit !== undefined &&
      window_ms !== undefined
    )
      meta.rate = { name, per, limit, window_ms };
  }
  return meta as Partial<RouteMeta>;
}

export function checkEntry(file: string, relativeToApp: string, source: string): InventoryEntry {
  const meta = parseRouteMeta(source);
  const problems: string[] = [];
  if (meta === null) {
    problems.push('no `export const routeMeta` literal (RouteMeta is required on every route)');
    return { file, meta, problems };
  }
  if (meta.path === undefined) problems.push('path missing');
  else if (meta.path !== pathFromFile(relativeToApp))
    problems.push(`path ${meta.path} does not match file location ${pathFromFile(relativeToApp)}`);
  if (meta.method !== 'GET' && meta.method !== 'POST') problems.push('method must be GET or POST');
  if (meta.auth === undefined || !AUTH_RULES.includes(meta.auth))
    problems.push('auth must be one of ' + AUTH_RULES.join(', '));
  if (meta.csrf === undefined) problems.push('csrf missing');
  if (meta.rate === undefined)
    problems.push('rate missing (use null only for a deliberate no-limit route)');
  if (
    meta.max_body_bytes === undefined ||
    meta.max_body_bytes < 1 ||
    meta.max_body_bytes > 1_048_576
  )
    problems.push('max_body_bytes must be 1..1048576');
  if (meta.idempotent === undefined) problems.push('idempotent missing');
  if (meta.risk !== 'low' && meta.risk !== 'medium' && meta.risk !== 'high')
    problems.push('risk must be low, medium or high');
  if (meta.method === 'POST' && meta.auth !== 'webhook' && meta.csrf === false)
    problems.push('POST route needs csrf: true');
  return { file, meta, problems };
}

export function formatInventory(entries: InventoryEntry[]): string {
  const rows = entries
    .filter((e) => e.meta !== null)
    .map((e) => {
      const m = e.meta as Partial<RouteMeta>;
      const rate = m.rate
        ? `${m.rate.name} ${m.rate.limit}/${m.rate.window_ms}ms ${m.rate.per}`
        : 'none';
      return `${m.method ?? '?'} ${m.path ?? '?'} auth=${m.auth ?? '?'} csrf=${m.csrf ?? '?'} rate=${rate} body<=${m.max_body_bytes ?? '?'} idem=${m.idempotent ?? '?'} risk=${m.risk ?? '?'}`;
    });
  return rows.sort().join('\n');
}
