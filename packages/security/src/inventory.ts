// Route inventory (SOP 5): static reading of the `routeMeta` literal that every route.ts exports.
// Pure and self-contained so scripts/route-inventory.mjs can load it directly (type imports only).
import type { AuthRule, RouteMeta } from './route';

export const AUTH_RULES: readonly AuthRule[] = [
  'public',
  'buyer',
  'publisher',
  'operator',
  'webhook',
  'owner',
  'apikey',
];

export interface InventoryEntry {
  file: string;
  /** The first meta of the file (the only one in a single-verb file), or null when there is none. */
  meta: Partial<RouteMeta> | null;
  /** Every meta of the file: routeMeta, or routeMetaGET, routeMetaPOST, ... in a multi-verb file. */
  metas?: Partial<RouteMeta>[];
  problems: string[];
}

const V1_PREFIX = '/api/v1/';
const META_VERBS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

// `app/(group)/api/orders/[id]/route.ts` -> `/api/orders/[id]`
export function pathFromFile(relativeToApp: string): string {
  const segs = relativeToApp
    .split('/')
    .slice(0, -1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'));
  return '/' + segs.join('/');
}

function literal(source: string, name = 'routeMeta'): string | null {
  const m = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*\\{`).exec(source);
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
    `(?:^|[\\s,{])${name}\\s*:\\s*('[^']*'|"[^"]*"|true|false|null|\\d[\\d_]*|\\{[^}]*\\}|\\[[^\\]]*\\])`,
  ).exec(body);
  return m?.[1] ?? null;
}

const str = (v: string | null): string | undefined =>
  v !== null && /^['"]/.test(v) ? v.slice(1, -1) : undefined;
const num = (v: string | null): number | undefined =>
  v !== null && /^\d/.test(v) ? Number(v.replace(/_/g, '')) : undefined;
const bool = (v: string | null): boolean | undefined =>
  v === 'true' ? true : v === 'false' ? false : undefined;

export function parseRouteMeta(source: string, name = 'routeMeta'): Partial<RouteMeta> | null {
  const body = literal(source, name);
  if (body === null) return null;
  const meta: Record<string, unknown> = {};
  for (const k of ['path', 'method', 'auth', 'risk']) {
    const v = str(field(body, k));
    if (v !== undefined) meta[k] = v;
  }
  for (const k of ['csrf', 'idempotent', 'fail_safe_without_mfa']) {
    const v = bool(field(body, k));
    if (v !== undefined) meta[k] = v;
  }
  const scopesText = field(body, 'scopes');
  if (scopesText !== null && scopesText.startsWith('[')) {
    meta.scopes = [...scopesText.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2] ?? '');
  }
  const mb = num(field(body, 'max_body_bytes'));
  if (mb !== undefined) meta.max_body_bytes = mb;
  const rule = (text: string | null): RouteMeta['rate_ip'] | undefined => {
    if (text === null || !text.startsWith('{')) return undefined;
    const name = str(field(text, 'name'));
    const per = str(field(text, 'per'));
    const limit = num(field(text, 'limit'));
    const window_ms = num(field(text, 'window_ms'));
    return name !== undefined &&
      (per === 'ip' || per === 'actor') &&
      limit !== undefined &&
      window_ms !== undefined
      ? { name, per, limit, window_ms }
      : undefined;
  };
  const rate = field(body, 'rate');
  if (rate === 'null') meta.rate = null;
  else {
    const r = rule(rate);
    if (r !== undefined) meta.rate = r;
  }
  // AI-H: the optional extra per-ip rule.
  const rateIp = field(body, 'rate_ip');
  if (rateIp !== null) {
    const r = rule(rateIp);
    meta.rate_ip = r ?? { name: '?', per: 'actor', limit: 0, window_ms: 0 };
  }
  return meta as Partial<RouteMeta>;
}

export const HTTP_VERBS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

// Blank out comments and the inside of string and template literals, keeping offsets and newlines,
// so the handler checks cannot be fooled by text that only looks like code.
export function stripNonCode(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += ' ';
          i++;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const STATEMENT_START =
  /^\s*(export|const|let|var|function|async|class|import|type|interface|enum)\b/;

// The text of the initializer that starts after `=` at `from`, up to the end of the statement.
function initializerAt(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth <= 0 && c === ';') return code.slice(from, i);
    else if (depth <= 0 && c === '\n') {
      const rest = code.slice(
        i + 1,
        code.indexOf('\n', i + 1) < 0 ? undefined : code.indexOf('\n', i + 1),
      );
      if (STATEMENT_START.test(rest)) return code.slice(from, i);
    }
  }
  return code.slice(from);
}

// Review H4: every exported HTTP handler must be built by withRoute(<its meta>, ...), and the verb
// must be the one that meta declares. `expected` maps each verb a file serves to the name of the meta
// that must build it (`routeMeta` in a single-verb file, `routeMetaGET`, `routeMetaPOST`, ... in a
// multi-verb file). Returns problems, empty when fine.
export function checkHandlersFor(source: string, expected: ReadonlyMap<string, string>): string[] {
  const code = stripNonCode(source);
  const problems: string[] = [];
  const verbs = new Set<string>();
  const verbRe = HTTP_VERBS.join('|');
  for (const m of code.matchAll(
    new RegExp(`export\\s+(?:async\\s+)?function\\s*\\*?\\s*(${verbRe})\\b`, 'g'),
  )) {
    verbs.add(m[1] as string);
    problems.push(`handler ${m[1]} is a plain function; build it with withRoute(routeMeta, ...)`);
  }
  for (const m of code.matchAll(
    new RegExp(`export\\s+(?:const|let|var)\\s+(${verbRe})\\b[^=]*=`, 'g'),
  )) {
    const verb = m[1] as string;
    verbs.add(verb);
    const init = initializerAt(code, m.index + m[0].length);
    const want = expected.get(verb);
    if (want !== undefined && !new RegExp(`\\bwithRoute\\s*\\(\\s*${want}\\s*,`).test(init))
      problems.push(`handler ${verb} is not built with withRoute(${want}, ...)`);
    else if (want === undefined && !/\bwithRoute\s*\(\s*routeMeta[A-Z]*\s*,/.test(init))
      problems.push(`handler ${verb} is not built with withRoute(routeMeta, ...)`);
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] as string).split(',')) {
      const name =
        part
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? '';
      if ((HTTP_VERBS as readonly string[]).includes(name)) {
        verbs.add(name);
        problems.push(
          `handler ${name} is exported by name or alias; build it with withRoute(routeMeta, ...)`,
        );
      }
    }
  }
  if (/export\s*\*\s*from/.test(code))
    problems.push('export * hides handlers; build each with withRoute(routeMeta, ...)');
  if (verbs.size === 0)
    problems.push('no exported handler (use export const POST = withRoute(routeMeta, ...))');
  for (const v of verbs)
    if (!expected.has(v))
      problems.push(
        `exported handler ${v} does not match routeMeta.method ${[...expected.keys()].join(', ') || '?'}`,
      );
  for (const v of expected.keys())
    if (!verbs.has(v)) problems.push(`routeMeta.method ${v} has no exported handler`);
  return problems;
}

/** Single-verb form of checkHandlersFor, kept for callers that hold one meta. */
export function checkHandlers(source: string, method: string | undefined): string[] {
  return checkHandlersFor(source, new Map(method === undefined ? [] : [[method, 'routeMeta']]));
}

/**
 * fail_safe_without_mfa lifts the MFA rule of an operator POST (BU-2). Exactly one route may carry
 * it: the stop button, which can only turn the outbound switch off.
 */
export const FAIL_SAFE_WITHOUT_MFA_ROUTES: readonly string[] = ['/api/ops/stop'];

// The rules one meta must meet. `where` names the meta in a message when a file holds several.
function metaProblems(meta: Partial<RouteMeta>, relativeToApp: string): string[] {
  const problems: string[] = [];
  if (meta.path === undefined) problems.push('path missing');
  else if (meta.path !== pathFromFile(relativeToApp))
    problems.push(`path ${meta.path} does not match file location ${pathFromFile(relativeToApp)}`);
  if (meta.method === undefined || !(META_VERBS as readonly string[]).includes(meta.method))
    problems.push('method must be GET, POST, PATCH or DELETE');
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
  if (
    meta.method !== undefined &&
    meta.method !== 'GET' &&
    meta.auth !== 'webhook' &&
    meta.auth !== 'apikey' &&
    meta.csrf === false
  )
    problems.push(`${meta.method} route needs csrf: true`);
  // API-W0: the bearer rules, the static half of validateMeta in route.ts.
  const v1 = meta.path !== undefined && meta.path.startsWith(V1_PREFIX);
  if (meta.method !== undefined && meta.method !== 'GET' && v1 && meta.idempotent === false)
    problems.push('a state change under /api/v1 needs idempotent: true');
  if (meta.scopes !== undefined && meta.auth !== 'apikey')
    problems.push('scopes are for apikey routes only');
  if (meta.auth === 'apikey') {
    if (!v1) problems.push('an apikey route must live under /api/v1/ (never under /api/ops)');
    if (meta.scopes === undefined || meta.scopes.length === 0)
      problems.push('an apikey route needs one or more scopes');
    if (meta.csrf === true) problems.push('an apikey route has no csrf (csrf: false)');
    if (meta.rate === undefined || meta.rate === null || meta.rate.per !== 'actor')
      problems.push('an apikey route needs a rate rule per actor (the key id)');
    if (
      meta.idempotent !== undefined &&
      meta.method !== undefined &&
      meta.idempotent !== (meta.method !== 'GET')
    )
      problems.push('an apikey route is idempotent exactly when it is not a GET');
  }
  if (meta.rate_ip !== undefined && (meta.rate_ip.per !== 'ip' || meta.rate_ip.limit < 1))
    problems.push('rate_ip must be an ip rule with a positive limit and window (AI-H)');
  if (meta.fail_safe_without_mfa === true) {
    if (meta.path === undefined || !FAIL_SAFE_WITHOUT_MFA_ROUTES.includes(meta.path))
      problems.push(
        `fail_safe_without_mfa is allowed only on ${FAIL_SAFE_WITHOUT_MFA_ROUTES.join(', ')}`,
      );
    if (meta.auth !== 'operator' || meta.method !== 'POST')
      problems.push('fail_safe_without_mfa is for operator POST routes only');
  }
  return problems;
}

export function checkEntry(file: string, relativeToApp: string, source: string): InventoryEntry {
  const plain = parseRouteMeta(source);
  const perVerb = META_VERBS.flatMap((v) => {
    const m = parseRouteMeta(source, `routeMeta${v}`);
    return m === null ? [] : [{ verb: v as string, name: `routeMeta${v}`, meta: m }];
  });
  const problems: string[] = [];
  if (plain === null && perVerb.length === 0) {
    problems.push('no `export const routeMeta` literal (RouteMeta is required on every route)');
    return { file, meta: null, problems };
  }
  if (plain !== null && perVerb.length > 0) {
    problems.push(
      'a file mixes routeMeta and routeMeta<VERB>; use routeMeta alone, or one routeMeta<VERB> per verb',
    );
    return { file, meta: plain, metas: [plain, ...perVerb.map((x) => x.meta)], problems };
  }
  const expected = new Map<string, string>();
  const metas: Partial<RouteMeta>[] = [];
  if (plain !== null) {
    metas.push(plain);
    problems.push(...metaProblems(plain, relativeToApp));
    if (plain.method !== undefined) expected.set(plain.method, 'routeMeta');
  } else {
    for (const x of perVerb) {
      metas.push(x.meta);
      for (const p of metaProblems(x.meta, relativeToApp)) problems.push(`${x.name}: ${p}`);
      if (x.meta.method !== x.verb)
        problems.push(`${x.name}: method must be ${x.verb} (found ${x.meta.method ?? 'none'})`);
      expected.set(x.verb, x.name);
    }
  }
  problems.push(...checkHandlersFor(source, expected));
  return { file, meta: metas[0] ?? null, metas, problems };
}

export function formatInventory(entries: InventoryEntry[]): string {
  const rows = entries
    .flatMap((e) => e.metas ?? (e.meta === null ? [] : [e.meta]))
    .map((m) => {
      const rate = m.rate
        ? `${m.rate.name} ${m.rate.limit}/${m.rate.window_ms}ms ${m.rate.per}`
        : 'none';
      const rateIp = m.rate_ip
        ? ` rate_ip=${m.rate_ip.name} ${m.rate_ip.limit}/${m.rate_ip.window_ms}ms ${m.rate_ip.per}`
        : '';
      const scopes = m.scopes !== undefined ? ` scopes=${m.scopes.join(',')}` : '';
      return `${m.method ?? '?'} ${m.path ?? '?'} auth=${m.auth ?? '?'} csrf=${m.csrf ?? '?'} rate=${rate}${rateIp} body<=${m.max_body_bytes ?? '?'} idem=${m.idempotent ?? '?'} risk=${m.risk ?? '?'}${scopes}${m.fail_safe_without_mfa === true ? ' failsafe_no_mfa=true' : ''}`;
    });
  return rows.sort().join('\n');
}
