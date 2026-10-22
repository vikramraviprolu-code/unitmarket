// UnitMarket PayPal sandbox spike kit (lane B-L6). Design: docs/design/mvp-plan.md, "Spike kit
// design". Owner runbook: docs/owner/SPIKE-RUNBOOK.md.
//
// One file, no dependencies, run by Node 22 type stripping:
//   node tools/spike-kit/src/spike.ts --dry-run          (replays bundled docs examples, no network)
//   node tools/spike-kit/src/spike.ts                    (owner only; needs the variables below)
//
// This file imports no product package and owns its copy of the sandbox host. The AI builders only
// ever run --dry-run, which cannot reach the network: the replay wire reads local files and the
// real wire is built only when every refusal check has passed and --dry-run is absent.
//
// Real runs need, in the process environment of an interactive terminal (never from a file):
//   SPIKE_OPERATOR=vikram|sakthi   SPIKE_APPROVAL_REF=D-nnn (a row of docs/decision-log.md)
//   SPIKE_MODE=read|write          PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox REST app)
// Exit codes: 0 done, 1 operator quit, 2 refused, 3 redaction failure, 4 transport error,
// 5 call cap reached.
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- constants ------------------------------------------------------------------------------------
export const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
export const SANDBOX_HOST = new URL(SANDBOX_API).hostname;
export const CALL_CAP = 40;
export const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 15_000;
const OPERATORS = ['vikram', 'sakthi'];
const APPROVAL_REF = /^D-\d{3,4}$/;
const R = '[redacted]';

export const REFUSAL_CODES = [
  'bad_args',
  'live_value',
  'non_sandbox_host',
  'ci_set',
  'not_tty',
  'bad_operator',
  'bad_mode',
  'approval_ref_missing',
  'approval_ref_pattern',
  'decision_log_unreadable',
  'approval_ref_unknown',
  'approval_ref_not_authorising',
  'approval_scope_mismatch',
  'approval_operator_mismatch',
  'approval_expired',
  'approval_ref_duplicate',
  'approval_window_invalid',
  'decision_log_unverified',
  'ai_environment',
  'transport_env_override',
  'credentials_missing',
  'output_in_repo',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export class SpikeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
class RunStop extends Error {
  exitCode: number;
  reason: string;
  constructor(exitCode: number, reason: string) {
    super(reason);
    this.exitCode = exitCode;
    this.reason = reason;
  }
}

// ---- types ----------------------------------------------------------------------------------------
export type Mode = 'read' | 'write' | 'all';
export interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}
export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}
/** The hint names a bundled fixture for the replay wire; the real wire ignores it. */
export type Wire = (req: WireRequest, hint: string) => Promise<WireResponse>;
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
  /** A real fetch Response has one; the wire reads it chunk by chunk so the cap holds early. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
}>;
export interface Deps {
  env: Record<string, string | undefined>;
  argv: string[];
  stdinIsTTY: boolean;
  nowIso: () => string;
  homeDir: string;
  tmpDir: string;
  repoRoot: string;
  readText: (path: string) => string | null;
  fixtureDir: string;
  ask: (question: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  fs: {
    mkdirp: (path: string) => void;
    writeFile: (path: string, text: string) => void;
    exists: (path: string) => boolean;
    /** Resolves symlinks. Optional so older callers compile; absent means lexical paths only. */
    realpath?: (path: string) => string;
  };
  fetchImpl?: FetchLike;
  /** process.execArgv of the running process; the real entry point supplies it. */
  execArgv?: readonly string[];
  /**
   * The committed text of a repository file (`git show HEAD:<path>`, local git only), or null when
   * git cannot answer. A real run needs it: docs/decision-log.md must equal HEAD (SEAL2 M1).
   */
  gitShowHead?: (relPath: string) => string | null;
}
export interface Config {
  dryRun: boolean;
  operator: string;
  approvalRef: string;
  mode: Mode;
  clientId: string;
  clientSecret: string;
  outDir: string;
}
export type Preflight =
  { ok: true; cfg: Config } | { ok: false; code: RefusalCode; message: string };

// ---- allow-list -----------------------------------------------------------------------------------
const ID = '[A-Z0-9]{1,36}';
export interface AllowedCall {
  method: 'GET' | 'POST';
  template: string;
  re: RegExp;
}
const allow = (method: 'GET' | 'POST', template: string): AllowedCall => ({
  method,
  template,
  re: new RegExp(`^${template.replace(/[.]/g, '\\.').replace(/\{id\}/g, ID)}$`),
});
/** Exactly the runbook calls. Payouts, Partner Referrals, webhooks, identity and v1 payments are not here. */
export const ALLOWED_CALLS: AllowedCall[] = [
  allow('POST', '/v1/oauth2/token'),
  allow('POST', '/v2/checkout/orders'),
  allow('GET', '/v2/checkout/orders/{id}'),
  allow('POST', '/v2/checkout/orders/{id}/capture'),
  allow('GET', '/v2/payments/captures/{id}'),
  allow('POST', '/v2/payments/captures/{id}/refund'),
  allow('GET', '/v2/payments/refunds/{id}'),
];
export function assertAllowedCall(method: string, path: string): AllowedCall {
  const hit = ALLOWED_CALLS.find((c) => c.method === method && c.re.test(path));
  if (!hit)
    throw new SpikeError(
      'path_not_allowed',
      `${method} ${path.slice(0, 80)} is not a runbook call`,
    );
  return hit;
}
/** Read mode may send GET and the token POST only. */
export function assertModeAllows(mode: Mode, method: string, path: string): void {
  if (mode === 'read' && method !== 'GET' && !(method === 'POST' && path === '/v1/oauth2/token'))
    throw new SpikeError('mode_violation', `read mode cannot send ${method} ${path.slice(0, 60)}`);
}

// ---- redaction ------------------------------------------------------------------------------------
export interface Redactor {
  redact<T>(value: T): T;
  text(s: string): string;
  /** Registered secrets only; for terminal output, where the owner needs real ids and links. */
  scrub(s: string): string;
  addSecret(s: string): void;
  secrets(): string[];
}
const FULL_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'client_id',
  'client_secret',
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'nonce',
  'password',
  'secret',
  'app_id',
  'paypal_auth_assertion',
  'paypal_client_metadata_id',
  'email',
  'email_address',
  'given_name',
  'surname',
  'full_name',
  'payer_id',
  'account_id',
  'customer_id',
  'vault_id',
  'account_number',
  'display_name',
  'business_name',
  'phone',
  'phone_number',
  'national_number',
  'address',
  'shipping_address',
  'billing_address',
  'payer_info',
  'address_line_1',
  'address_line_2',
  'admin_area_1',
  'admin_area_2',
  'postal_code',
  'birth_date',
  'tax_id',
]);
const TAIL6_KEYS = new Set(['id', 'order_id', 'capture_id', 'refund_id', 'authorization_id']);
const TAIL4_KEYS = new Set(['merchant_id', 'payee_id']);
const NAME_PARENTS = new Set(['payer', 'shipping', 'payee_name', 'recipient', 'billing_info']);
const normKey = (k: string) => k.toLowerCase().replace(/-/g, '_');
const tail = (s: string, n: number) =>
  s.startsWith('***') ? s : s.length <= n ? R : `***${s.slice(-n)}`;

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  const text = (input: string): string => {
    let s = input;
    for (const sec of secrets) if (s.includes(sec)) s = s.split(sec).join(R);
    s = s.replace(
      /([?&;](?:token|access_token|client_secret|nonce|PayerID|payer_id|ba_token)=)[^&\s"'<>]+/gi,
      `$1${R}`,
    );
    s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`);
    s = s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, R);
    s = s.replace(/A21[A-Za-z0-9._-]{20,}/g, R);
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, R);
    s = s.replace(
      /(\/(?:orders|captures|refunds|authorizations)\/)([A-Za-z0-9]{7,})/g,
      (_m, p: string, id: string) => `${p}***${id.slice(-6)}`,
    );
    s = s.replace(
      /\b(?=[0-9A-Z]{17}\b)(?=[A-Z0-9]*\d)[0-9A-Z]{17}\b/g,
      (id) => `***${id.slice(-6)}`,
    );
    s = s.replace(/(?<![*A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, R);
    return s;
  };
  const scrub = (input: string): string => {
    let s = input;
    for (const sec of secrets) if (s.includes(sec)) s = s.split(sec).join(R);
    return s;
  };
  const walk = (v: unknown, parent: string, depth: number): unknown => {
    if (depth > 24) return R;
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, parent, depth + 1));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const nk = normKey(k);
        if (FULL_KEYS.has(nk) || (nk === 'name' && NAME_PARENTS.has(parent))) {
          out[k] = R;
        } else if (TAIL6_KEYS.has(nk) && typeof val === 'string') {
          out[k] = tail(val, 6);
        } else if (TAIL4_KEYS.has(nk) && typeof val === 'string') {
          out[k] = tail(val, 4);
        } else {
          out[k] = walk(val, nk, depth + 1);
        }
      }
      return out;
    }
    return v;
  };
  return {
    redact: <T>(value: T): T => walk(value, '', 0) as T,
    text,
    scrub,
    addSecret: (s) => {
      if (s.length >= 6) secrets.add(s);
    },
    secrets: () => [...secrets],
  };
}

/** Canary check. Returns the canaries that survived redaction; an empty list is a pass. */
export function redactionSelfTest(make: () => Redactor): string[] {
  const c = {
    token: 'A21AA' + 'CANARYTOKEN' + 'abcdefghijklmnopqrstuvwxyz0123456789',
    secret: 'canary-client-secret-' + '7f3a9c1d',
    clientId: 'canary-client-id-' + '55aa',
    email: 'canary.payer' + '@example.test',
    given: 'Canarygiven',
    surname: 'Canarysurname',
    payerId: 'CANARYPAYER' + 'ID1',
    accountId: 'CANARYACCT' + 'ID1',
    street: 'Canary Street 9',
    phone: '0049' + '555123456',
    nonce: 'canary-nonce-' + '12345',
    orderId: '5CANARY0RDER' + '99999',
    merchant: 'CANARYMERCH' + 'ANT1',
    jwt: 'eyJ' + 'canaryheader1234.canarypayload5678.canarysig',
    opaque: 'canaryopaque' + 'Z'.repeat(44),
    query: 'canaryquerytoken' + '987',
    freeBearer: 'canaryfreebearer' + '4455',
  };
  const r = make();
  r.addSecret(c.secret);
  r.addSecret(c.clientId);
  const basic = Buffer.from(`${c.clientId}:${c.secret}`).toString('base64');
  r.addSecret(basic);
  const sample = {
    request: {
      headers: { Authorization: `Bearer ${c.token}`, 'x-note': `Basic ${basic}` },
      body: `grant_type=client_credentials&client_secret=${c.secret}`,
    },
    response: {
      access_token: c.token,
      id_token: c.jwt,
      nonce: c.nonce,
      id: c.orderId,
      payer: {
        email_address: c.email,
        payer_id: c.payerId,
        account_id: c.accountId,
        name: { given_name: c.given, surname: c.surname },
        address: { address_line_1: c.street },
        phone: { phone_number: { national_number: c.phone } },
      },
      payee: { merchant_id: c.merchant },
      links: [
        {
          rel: 'approve',
          href: `https://www.sandbox.example.invalid/c?token=${c.query}&PayerID=${c.payerId}`,
        },
        { rel: 'self', href: `/v2/checkout/orders/${c.orderId}` },
      ],
      message: `mail ${c.email} sent with Bearer ${c.freeBearer} and ${c.opaque}`,
      nested: [[{ deep: { secret: c.secret, note: `id ${c.clientId}` } }]],
    },
  };
  const rendered = JSON.stringify(r.redact(sample));
  const checks: Array<[string, string]> = [
    ['access token', c.token],
    ['client secret', c.secret],
    ['client id', c.clientId],
    ['basic header', basic],
    ['email', c.email],
    ['given name', c.given],
    ['surname', c.surname],
    ['payer id', c.payerId],
    ['account id', c.accountId],
    ['street', c.street],
    ['phone', c.phone],
    ['nonce', c.nonce],
    ['order id', c.orderId],
    ['merchant id', c.merchant],
    ['jwt', c.jwt],
    ['opaque string', c.opaque],
    ['url token', c.query],
    ['bearer in text', c.freeBearer],
  ];
  return checks.filter(([, needle]) => rendered.includes(needle)).map(([name]) => name);
}

// ---- wires ----------------------------------------------------------------------------------------
/** The real wire. It checks scheme, host, port, userinfo and path before any fetch, never follows a
 * redirect, times out, caps the response, and never retries. Built only after every refusal check. */
export function createSpikeFetchWire(
  fetchImpl: FetchLike,
  /** Says which override is present right now, or null. Asked before every request (SEAL2 M3). */
  recheck: () => string | null,
): Wire {
  return async (req) => {
    let overridden: string | null;
    try {
      overridden = recheck();
    } catch {
      overridden = 'the override check';
    }
    if (overridden !== null)
      throw new SpikeError(
        'transport_env_override',
        `${overridden} is set; the run stops before this request`,
      );
    const u = new URL(req.url);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== SANDBOX_HOST ||
      u.port !== '' ||
      u.username ||
      u.password
    )
      throw new SpikeError('host_not_allowed', 'the request does not target the sandbox host');
    if (u.search || u.hash) throw new SpikeError('path_not_allowed', 'query strings are not used');
    assertAllowedCall(req.method, u.pathname);
    const init: Parameters<FetchLike>[1] = {
      method: req.method,
      headers: req.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(req.body === null ? {} : { body: req.body }),
    };
    const res = await fetchImpl(`${SANDBOX_API}${u.pathname}`, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const tooLarge = () => new SpikeError('response_too_large', 'response too large (over 1 MB)');
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw tooLarge();
    // L5: count bytes while streaming and stop at the cap; a huge body is never held in memory.
    if (res.body) {
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        parts.push(value);
      }
      const all = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        all.set(part, at);
        at += part.byteLength;
      }
      return { status: res.status, headers, text: new TextDecoder().decode(all) };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) throw tooLarge();
    return { status: res.status, headers, text: new TextDecoder().decode(buf) };
  };
}

/** The dry-run wire: answers from a bundled fixture file named by the hint. No network object. */
export function createReplayWire(fixtureDir: string, readText: (p: string) => string | null): Wire {
  return async (req, hint) => {
    if (hint === 'synthetic:token')
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          scope: 'https://uri.example.invalid/services/synthetic',
          access_token: 'DRYRUN-FAKE-TOKEN-' + '0'.repeat(24),
          token_type: 'Bearer',
          app_id: 'SYNTHETIC',
          expires_in: 32400,
          nonce: 'synthetic-nonce',
        }),
      };
    const raw = readText(join(fixtureDir, `${hint}.json`));
    if (raw === null) throw new SpikeError('fixture_missing', `no bundled fixture named ${hint}`);
    const fx = JSON.parse(raw) as {
      request: { method: string; path_template: string };
      response: { status: number; headers?: Record<string, string>; body: unknown };
    };
    const want = new RegExp(`^${fx.request.path_template.replace(/\{id\}/g, '[A-Za-z0-9]+')}$`);
    if (fx.request.method !== req.method || !want.test(new URL(req.url).pathname))
      throw new SpikeError(
        'fixture_mismatch',
        `fixture ${hint} does not match ${req.method} ${req.url}`,
      );
    return {
      status: fx.response.status,
      headers: fx.response.headers ?? {},
      text: JSON.stringify(fx.response.body),
    };
  };
}

// ---- preflight ------------------------------------------------------------------------------------
interface Args {
  dryRun: boolean;
  help: boolean;
  out: string | null;
}
function parseArgs(argv: string[]): Args | null {
  const a: Args = { dryRun: false, help: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (
      t === '--out' &&
      typeof argv[i + 1] === 'string' &&
      !(argv[i + 1] as string).startsWith('--')
    )
      a.out = argv[++i] as string;
    else return null;
  }
  return a;
}
const refuse = (code: RefusalCode, message: string): Preflight => ({ ok: false, code, message });
const LIVE = /live|production/i;
// L5: the usual CI markers. A real run refuses all of them; a dry run is allowed anywhere.
const CI_MARKERS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'JENKINS_URL',
  'CIRCLECI',
  'TF_BUILD',
  'CODESPACES',
];
// LOW (SEAL2): sessions of an AI coding agent or a cloud IDE. A real run refuses them; --dry-run
// is allowed anywhere.
const AI_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_REMOTE'];
// Anything that changes where a connection goes, which certificates it trusts, or which code runs
// inside the process. The same list guards boot (packages/config) and every request of the wires
// (FIX-MVPB-SEAL2 M3); keep the three copies in step (each has a test for each entry).
const OVERRIDE_NAMES: ReadonlySet<string> = new Set([
  'NODE_USE_ENV_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NODE_USE_SYSTEM_CA',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const OVERRIDE_FLAG =
  /^(?:--use-env-proxy|--require|-r|--import|--inspect(?:-brk|-wait)?|--loader|--experimental-loader|--use-system-ca|--use-openssl-ca|--openssl-config|--openssl-shared-config)(?:=|$)/;
/**
 * The name of the first environment variable, or `execArgv` for a Node flag, that overrides the
 * network path or the trust store; null when none does. Names only, never values.
 */
export function networkOverride(
  env: Record<string, string | undefined>,
  execArgv: readonly string[],
): string | null {
  for (const [name, v] of Object.entries(env)) {
    if (OVERRIDE_NAMES.has(name.toUpperCase()) && v !== undefined && v.trim() !== '')
      return name.toUpperCase();
  }
  return execArgv.some((a) => OVERRIDE_FLAG.test(a)) ? 'execArgv' : null;
}
const HOSTISH = /(?:https?:\/\/[^\s/"']+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev)\b)/gi;

/**
 * The path with symlinks resolved: realpath of the nearest existing ancestor, plus the part that
 * does not exist yet. Falls back to the lexical path if the file system cannot answer.
 */
function realLocation(p: string, fsx: Deps['fs']): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    if (fsx.exists(cur)) {
      try {
        const r = (fsx.realpath as (x: string) => string)(cur);
        return join(r, ...rest.reverse());
      } catch {
        return resolve(p);
      }
    }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.push(cur.slice(up.length + 1));
    cur = up;
  }
}

function insideGitRepo(dir: string, exists: (p: string) => boolean): boolean {
  let cur = resolve(dir);
  for (;;) {
    if (exists(join(cur, '.git'))) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/**
 * The only shape that grants: the whole Decision cell of a table row is exactly this marker
 * (FIX-BPREP H1, anchored in FIX-MVPB-SEAL2 M1). Text before or after it, a quote, a different
 * letter case or a second marker in another cell never grants.
 */
const SPIKE_GO =
  /^SPIKE GO: scope=(spike-read|spike-write); operator=(vikram|sakthi); valid_until=(\d{4}-\d{2}-\d{2}); approved in writing (\d{4}-\d{2}-\d{2})$/;
// Words that turn a row into something other than a grant, wherever they appear in the row
// (the notes cell included): negations, withdrawals, templates and examples.
const NON_GRANTING =
  /\b(?:not|no longer|cannot|can't|won't|never|revok\w*|withdr[ae]w\w*|supersed\w*|templat\w*|example\w*|sample|placeholder)\b|n't\b|\be\.g\./i;
const MAX_GO_DAYS = 14;
function realDate(iso: string): boolean {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso;
}
const dayNumber = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
export function parseSpikeGo(row: string): {
  scope: 'spike-read' | 'spike-write';
  operator: string;
  validUntil: string;
  approved: string;
} | null {
  if (typeof row !== 'string' || NON_GRANTING.test(row)) return null;
  const t = row.trim();
  if (!t.startsWith('|')) return null;
  // | Id | Date | Decision | Owner | Notes |
  const cells = t
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
  if (cells.length < 4) return null;
  const m = SPIKE_GO.exec(cells[2] as string);
  if (m === null) return null;
  if (!realDate(m[3] as string) || !realDate(m[4] as string)) return null;
  return {
    scope: m[1] as 'spike-read' | 'spike-write',
    operator: m[2] as string,
    validUntil: m[3] as string,
    approved: m[4] as string,
  };
}

/**
 * The lines of the log that start the table row `ref`, and whether each sits where Markdown shows
 * code instead of a table: a ``` or ~~~ fence, an HTML comment, or a block indented four columns.
 */
function findRows(log: string, ref: string): { line: string; hidden: boolean }[] {
  const out: { line: string; hidden: boolean }[] = [];
  const head = new RegExp(`^\\s*\\|\\s*${ref}\\s*\\|`);
  let fence: string | null = null;
  let comment = false;
  for (const line of log.split('\n')) {
    const opener = /^(```|~~~)/.exec(line.trimStart());
    if (fence !== null) {
      if (opener !== null && opener[1] === fence) {
        fence = null;
        continue;
      }
    } else if (opener !== null) {
      fence = opener[1] as string;
      continue;
    }
    const opens = line.includes('<!--');
    const closes = line.includes('-->');
    const inComment = comment || opens;
    if (opens && !closes) comment = true;
    else if (comment && closes) comment = false;
    if (head.test(line))
      out.push({
        line,
        hidden: fence !== null || inComment || /^(?: {4}|\t)/.test(line),
      });
  }
  return out;
}

export function preflight(deps: Deps): Preflight {
  const args = parseArgs(deps.argv);
  if (args === null)
    return refuse('bad_args', 'unknown argument; use --dry-run, --out <dir> or --help');
  const env = deps.env;
  // Values and names of every SPIKE_ and PAYPAL_ variable: no live or production, no other host.
  for (const [k, v] of Object.entries(env)) {
    if (!/^(SPIKE|PAYPAL)_/.test(k)) continue;
    if (LIVE.test(k)) return refuse('live_value', `variable name ${k} mentions live or production`);
    if (typeof v !== 'string') continue;
    if (LIVE.test(v)) return refuse('live_value', `the value of ${k} contains live or production`);
    for (const m of v.matchAll(HOSTISH)) {
      const host = m[0].replace(/^https?:\/\//i, '').toLowerCase();
      if (host !== SANDBOX_HOST && !host.endsWith('.sandbox.paypal.com'))
        return refuse(
          'non_sandbox_host',
          `the value of ${k} names a host that is not the sandbox host`,
        );
    }
  }
  const modeRaw = env['SPIKE_MODE'];
  const date = deps.nowIso().slice(0, 10);
  const outBase = args.out
    ? resolve(args.out)
    : args.dryRun
      ? join(deps.tmpDir, 'unitmarket-spike-dryrun', date)
      : join(deps.homeDir, 'unitmarket-spike', date);
  const checkOut = (): Preflight | null => {
    // L4: judge the real location. A symlink (or a chain of them) into the repository is the repo.
    const real = deps.fs.realpath ? realLocation(outBase, deps.fs) : outBase;
    const rootReal = deps.fs.realpath
      ? realLocation(resolve(deps.repoRoot), deps.fs)
      : resolve(deps.repoRoot);
    const rootPrefixes = [resolve(deps.repoRoot) + sep, rootReal + sep];
    for (const p of [outBase, real]) {
      if (rootPrefixes.some((rp) => (p + sep).startsWith(rp)) || insideGitRepo(p, deps.fs.exists))
        return refuse('output_in_repo', 'the output directory must be outside any git repository');
    }
    return null;
  };
  if (args.dryRun) {
    if (modeRaw !== undefined && modeRaw !== '' && modeRaw !== 'read' && modeRaw !== 'write')
      return refuse('bad_mode', 'SPIKE_MODE must be read or write');
    const bad = checkOut();
    if (bad) return bad;
    return {
      ok: true,
      cfg: {
        dryRun: true,
        operator: 'dry-run',
        approvalRef: 'none',
        mode: modeRaw === 'read' || modeRaw === 'write' ? modeRaw : 'all',
        clientId: '',
        clientSecret: '',
        outDir: outBase,
      },
    };
  }
  for (const name of CI_MARKERS) {
    const v = env[name];
    if (v !== undefined && v !== '')
      return refuse('ci_set', `${name} is set; the kit never runs in CI`);
  }
  // M1: nothing may sit between this process and the sandbox host, and the CA store stays default.
  const overridden = networkOverride(env, deps.execArgv ?? []);
  if (overridden === 'execArgv')
    return refuse(
      'transport_env_override',
      'a Node flag that changes networking or loads code is set',
    );
  if (overridden !== null)
    return refuse(
      'transport_env_override',
      `${overridden} is set; run on your own machine, off VPN, not in a container`,
    );
  for (const name of AI_MARKERS) {
    const v = env[name];
    if (v !== undefined && v.trim() !== '')
      return refuse(
        'ai_environment',
        `${name} is set; the spike is run by the owner by hand, never from an AI or cloud session`,
      );
  }
  if (!deps.stdinIsTTY)
    return refuse('not_tty', 'stdin is not a terminal; run it by hand in a terminal');
  const operator = env['SPIKE_OPERATOR'];
  if (operator === undefined || !OPERATORS.includes(operator))
    return refuse('bad_operator', 'SPIKE_OPERATOR must be vikram or sakthi');
  if (modeRaw !== 'read' && modeRaw !== 'write')
    return refuse('bad_mode', 'SPIKE_MODE must be read or write');
  const ref = env['SPIKE_APPROVAL_REF'];
  if (ref === undefined || ref === '')
    return refuse('approval_ref_missing', 'SPIKE_APPROVAL_REF is not set');
  if (!APPROVAL_REF.test(ref))
    return refuse('approval_ref_pattern', 'SPIKE_APPROVAL_REF must look like D-024');
  const log = deps.readText(join(deps.repoRoot, 'docs', 'decision-log.md'));
  if (log === null) return refuse('decision_log_unreadable', 'docs/decision-log.md cannot be read');
  // The log the grant is read from must be the committed one: a row typed into a working copy, or
  // a missing git, is not an approval (SEAL2 M1).
  let committed: string | null = null;
  try {
    committed = deps.gitShowHead ? deps.gitShowHead('docs/decision-log.md') : null;
  } catch {
    committed = null;
  }
  if (committed === null)
    return refuse(
      'decision_log_unverified',
      'git cannot show docs/decision-log.md at HEAD; run inside the repository clone with git installed',
    );
  if (committed !== log)
    return refuse(
      'decision_log_unverified',
      'docs/decision-log.md differs from the committed copy; commit or discard the change first',
    );
  const rows = findRows(log, ref);
  if (rows.length === 0)
    return refuse('approval_ref_unknown', `no row ${ref} in docs/decision-log.md`);
  if (rows.length > 1)
    return refuse('approval_ref_duplicate', `docs/decision-log.md has more than one row ${ref}`);
  const row = rows[0] as { line: string; hidden: boolean };
  if (row.hidden)
    return refuse(
      'approval_ref_not_authorising',
      `row ${ref} sits in a code block or comment, not in the table`,
    );
  const go = parseSpikeGo(row.line);
  if (go === null)
    return refuse(
      'approval_ref_not_authorising',
      `row ${ref} carries no well-formed SPIKE GO marker (see docs/owner/SPIKE-RUNBOOK.md)`,
    );
  if (!(modeRaw === 'write' ? go.scope === 'spike-write' : go.scope !== null))
    return refuse('approval_scope_mismatch', `row ${ref} does not cover mode ${modeRaw}`);
  if (go.operator !== operator)
    return refuse('approval_operator_mismatch', `row ${ref} names a different operator`);
  // approved <= today <= valid_until, and the window is at most 14 days.
  if (
    go.approved > go.validUntil ||
    dayNumber(go.validUntil) - dayNumber(go.approved) > MAX_GO_DAYS ||
    date < go.approved
  )
    return refuse(
      'approval_window_invalid',
      `row ${ref} must be approved on or before today, and valid for at most ${MAX_GO_DAYS} days`,
    );
  if (date > go.validUntil) return refuse('approval_expired', `row ${ref} has expired`);
  const clientId = env['PAYPAL_CLIENT_ID'];
  const clientSecret = env['PAYPAL_CLIENT_SECRET'];
  if (!clientId || !clientSecret)
    return refuse(
      'credentials_missing',
      'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in the environment',
    );
  const bad = checkOut();
  if (bad) return bad;
  return {
    ok: true,
    cfg: {
      dryRun: false,
      operator,
      approvalRef: ref,
      mode: modeRaw,
      clientId,
      clientSecret,
      outDir: outBase,
    },
  };
}

// ---- JSON helpers ---------------------------------------------------------------------------------
type Obs = Record<string, unknown>;
function dig(v: unknown, ...keys: Array<string | number>): unknown {
  let cur: unknown = v;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rels = (b: unknown): string[] => arr(dig(b, 'links')).map((l) => str(dig(l, 'rel')) ?? '?');
const hostOf = (href: unknown): string | null => {
  try {
    return new URL(String(href)).host;
  } catch {
    return null;
  }
};
const approvalHref = (b: unknown): string | undefined => {
  const l = arr(dig(b, 'links')).find((x) =>
    ['payer-action', 'approve'].includes(str(dig(x, 'rel')) ?? ''),
  );
  return str(dig(l, 'href'));
};
const errName = (b: unknown) => str(dig(b, 'name')) ?? str(dig(b, 'error'));
const errIssue = (b: unknown) => arr(dig(b, 'details')).map((d) => str(dig(d, 'issue')) ?? '?');
function shape(v: unknown, prefix = '', out = new Set<string>()): string[] {
  if (out.size > 300) return [...out].sort();
  if (Array.isArray(v)) {
    for (const x of v) shape(x, `${prefix}[]`, out);
    if (v.length === 0) out.add(`${prefix}[]`);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      shape(x, prefix ? `${prefix}.${k}` : k, out);
  } else out.add(prefix);
  return [...out].sort();
}
interface Res {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  text: string;
}
const debugHeaders = (h: Record<string, string>) => Object.keys(h).filter((k) => /debug/i.test(k));

// ---- run state ------------------------------------------------------------------------------------
interface CallRecord {
  label: string;
  call_number: number;
  request: {
    method: string;
    path_template: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    debug_header_names: string[];
    body: unknown;
  } | null;
  expected_status: number[] | null;
  matches_expectation: boolean | null;
  observations: Obs;
}
interface StepRec {
  id: number;
  slug: string;
  title: string;
  part: 'R' | 'W' | 'manual';
  status: 'done' | 'declined' | 'skipped' | 'not_applicable' | 'deferred' | 'aborted' | 'not_run';
  calls: CallRecord[];
  notes: string[];
  extra: Obs;
}
interface Ctx {
  cfg: Config;
  deps: Deps;
  wire: Wire;
  redactor: Redactor;
  cap: number;
  calls: number;
  token: string | null;
  tokenExpiresMs: number;
  steps: StepRec[];
  runTag: string;
}
interface CallSpec {
  label: string;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  hint: string;
  writes: boolean;
  expect?: number[];
  observe?: (res: Res) => Obs;
  tokenCall?: boolean;
}

const say = (ctx: Ctx, line: string) => ctx.deps.out(ctx.redactor.scrub(line));

async function confirm(ctx: Ctx, question: string): Promise<boolean> {
  if (ctx.cfg.dryRun) {
    say(ctx, `${question} [dry-run auto: y]`);
    return true;
  }
  const ans = (await ctx.deps.ask(question)).trim().toLowerCase();
  if (ans === 'q' || ans === 'quit') throw new RunStop(1, 'operator quit');
  return ans === 'y' || ans === 'yes';
}
async function askText(ctx: Ctx, question: string, dryAnswer: string): Promise<string> {
  if (ctx.cfg.dryRun) {
    say(ctx, `${question} [dry-run auto: ${dryAnswer || 'skip'}]`);
    return dryAnswer;
  }
  const a = (await ctx.deps.ask(question)).trim();
  if (a.toLowerCase() === 'q' || a.toLowerCase() === 'quit') throw new RunStop(1, 'operator quit');
  return a;
}

function maskHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'authorization') out[k] = `${v.split(' ')[0] ?? ''} [masked]`;
    else out[k] = v;
  }
  return out;
}

async function call(ctx: Ctx, rec: StepRec, spec: CallSpec): Promise<CallRecord | null> {
  const tpl = assertAllowedCall(spec.method, spec.path);
  assertModeAllows(ctx.cfg.mode, spec.method, spec.path);
  if (!spec.tokenCall) {
    if (ctx.token !== null && Date.parse(ctx.deps.nowIso()) >= ctx.tokenExpiresMs - 60_000) {
      rec.notes.push('token expired; asked for a new one');
      ctx.token = null;
      await obtainToken(ctx, rec);
    }
    if (ctx.token === null) {
      rec.notes.push(`${spec.label}: skipped, no access token`);
      return null;
    }
  }
  const headers: Record<string, string> = { accept: 'application/json', ...(spec.headers ?? {}) };
  headers['authorization'] = spec.tokenCall
    ? `Basic ${Buffer.from(`${ctx.cfg.clientId}:${ctx.cfg.clientSecret}`).toString('base64')}`
    : `Bearer ${ctx.token}`;
  let body: string | null = null;
  if (typeof spec.body === 'string') body = spec.body;
  else if (spec.body !== undefined && spec.body !== null) {
    body = JSON.stringify(spec.body);
    headers['content-type'] = 'application/json';
  }
  const url = `${SANDBOX_API}${spec.path}`;
  const req: WireRequest = { method: spec.method, url, headers, body };
  const n = ctx.calls + 1;
  say(ctx, '');
  say(ctx, `Step ${rec.id} - ${rec.title}`);
  say(ctx, `  ${spec.label}${spec.writes ? ' (WRITE: creates or changes sandbox data)' : ''}`);
  say(ctx, `  ${spec.method} ${url}`);
  say(ctx, `  headers: ${JSON.stringify(maskHeaders(headers))}`);
  say(ctx, `  body: ${body ?? '(none)'}`);
  say(ctx, `  this would be call ${n} of ${ctx.cap}`);
  if (!(await confirm(ctx, 'Send this request? [y/N] '))) {
    rec.notes.push(`${spec.label}: declined by operator, nothing sent`);
    return null;
  }
  if (
    spec.writes &&
    !(await confirm(ctx, 'Second confirmation: this is a sandbox write. Send it? [y/N] '))
  ) {
    rec.notes.push(`${spec.label}: declined at second confirmation, nothing sent`);
    return null;
  }
  if (ctx.calls >= ctx.cap)
    throw new RunStop(5, `call cap of ${ctx.cap} reached before ${spec.label}`);
  ctx.calls += 1;
  let wireRes: WireResponse;
  try {
    wireRes = await ctx.wire(req, spec.hint);
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    const msg = e instanceof Error ? ctx.redactor.text(e.message).slice(0, 200) : '';
    rec.notes.push(`${spec.label}: transport error (${name}: ${msg}); not retried`);
    throw new RunStop(4, `transport error on ${spec.label} (${name}: ${msg}); not retried`);
  }
  let json: unknown = undefined;
  try {
    json = wireRes.text === '' ? undefined : JSON.parse(wireRes.text);
  } catch {
    json = undefined;
  }
  const res: Res = { status: wireRes.status, headers: wireRes.headers, json, text: wireRes.text };
  const obs: Obs = { http_status: res.status, ...(spec.observe ? spec.observe(res) : {}) };
  const dbg = debugHeaders(res.headers);
  const keep: Record<string, string> = {};
  for (const k of Object.keys(res.headers))
    if (k === 'content-type' || /debug/i.test(k)) keep[k] = res.headers[k] as string;
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) reqHeaders[k] = k === 'authorization' ? R : v;
  const record: CallRecord = {
    label: spec.label,
    call_number: ctx.calls,
    request: {
      method: spec.method,
      path_template: tpl.template,
      path: spec.path,
      headers: reqHeaders,
      body: spec.tokenCall
        ? 'grant_type=client_credentials'
        : typeof spec.body === 'string'
          ? spec.body
          : (spec.body ?? null),
    },
    response: {
      status: res.status,
      headers: keep,
      debug_header_names: dbg,
      body: json !== undefined ? json : res.text.slice(0, 2000),
    },
    expected_status: spec.expect ?? null,
    matches_expectation: spec.expect ? spec.expect.includes(res.status) : null,
    observations: obs,
  };
  const clean = ctx.redactor.redact(record);
  rec.calls.push(clean);
  if (spec.tokenCall) {
    const at = str(dig(json, 'access_token'));
    if (res.status === 200 && at) {
      ctx.token = at;
      ctx.redactor.addSecret(at);
      const exp = Number(dig(json, 'expires_in'));
      ctx.tokenExpiresMs =
        Date.parse(ctx.deps.nowIso()) + (Number.isFinite(exp) ? exp * 1000 : 3_600_000);
    } else
      throw new RunStop(
        4,
        `token request failed with HTTP ${res.status}; check the sandbox credentials`,
      );
  }
  say(
    ctx,
    `  -> HTTP ${res.status}${clean.matches_expectation === false ? ` (expected ${spec.expect?.join(' or ')})` : ''}`,
  );
  return clean;
}

// ---- steps ----------------------------------------------------------------------------------------
const KEYS = {
  K1: 'spike-K1',
  K2: 'spike-K2',
  K3: 'spike-K3',
  K4: 'spike-K4',
  K5: 'spike-K5',
  K6: 'spike-K6',
  K7: 'spike-K7',
  K8: 'spike-K8',
  K9: 'spike-K9',
  K10: 'spike-K10',
  K11: 'spike-K11',
  K12: 'spike-K12',
  K13: 'spike-K13',
  E1: 'spike-E1',
  E2: 'spike-E2',
  E3: 'spike-E3',
  E4: 'spike-E4',
} as const;
const RETURN_URL = 'https://example.invalid/return';
const CANCEL_URL = 'https://example.invalid/cancel';

function orderBody(
  ctx: Ctx,
  currency: string,
  units: Array<{ ref: string; custom?: string; invoice?: string; payee?: string }>,
): unknown {
  return {
    intent: 'CAPTURE',
    purchase_units: units.map((u) => ({
      reference_id: u.ref,
      ...(u.custom ? { custom_id: u.custom } : {}),
      ...(u.invoice ? { invoice_id: u.invoice } : {}),
      amount: { currency_code: currency, value: '1.00' },
      ...(u.payee ? { payee: { merchant_id: u.payee } } : {}),
    })),
    payment_source: {
      paypal: {
        experience_context: {
          return_url: RETURN_URL,
          cancel_url: CANCEL_URL,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    },
  };
}
const orderHeaders = (key: string) => ({
  'paypal-request-id': key,
  prefer: 'return=representation',
});
const idOnly = (b: unknown): string | undefined => str(dig(b, 'id'));
const firstCapture = (b: unknown): unknown =>
  dig(b, 'purchase_units', 0, 'payments', 'captures', 0);

/** Call wrapper that also remembers the raw response for flow decisions (never written). */
async function callRaw(
  ctx: Ctx,
  rec: StepRec,
  spec: CallSpec,
): Promise<{ rec: CallRecord; res: Res } | null> {
  let captured: Res | null = null;
  const observe = spec.observe;
  const r = await call(ctx, rec, {
    ...spec,
    observe: (res) => {
      captured = res;
      return observe ? observe(res) : {};
    },
  });
  if (r === null || captured === null) return null;
  return { rec: r, res: captured };
}

interface Cycle {
  currency: string;
  orderId: string | undefined;
  approveUrl: string | undefined;
  captureId: string | undefined;
  captureStatus: string | undefined;
}

type RecFor = (n: number) => StepRec;
const pad = (n: number) => String(n).padStart(2, '0');

async function approveInBrowser(
  ctx: Ctx,
  rec: StepRec,
  url: string | undefined,
  who: string,
): Promise<boolean> {
  if (!url) {
    rec.notes.push(`${who}: no approval link, cannot approve`);
    return false;
  }
  say(ctx, '');
  say(
    ctx,
    `Open this link in a browser, log in as the sandbox PERSONAL (buyer) account, and approve (${who}):`,
  );
  say(ctx, `  ${url}`);
  say(ctx, '(The link is shown on screen only. It is never saved.)');
  return confirm(ctx, 'Type y when you have approved the payment in the browser, n to skip: ');
}

async function cycle(
  ctx: Ctx,
  recFor: RecFor,
  currency: string,
  keys: { c: string; early: string; cap: string; again: string },
  label: string,
): Promise<Cycle> {
  const cy: Cycle = {
    currency,
    orderId: undefined,
    approveUrl: undefined,
    captureId: undefined,
    captureStatus: undefined,
  };
  const inv = `spike-inv-${ctx.runTag}-${currency}`;
  const body = orderBody(ctx, currency, [
    { ref: 'spike-A', custom: 'spike-custom-1', invoice: inv },
  ]);
  const create = (key: string, step: number, name: string) =>
    callRaw(ctx, recFor(step), {
      label: `${label}${name}`,
      method: 'POST',
      path: '/v2/checkout/orders',
      headers: orderHeaders(key),
      body,
      hint: 'docs_create_201_payer_action__create_order__1',
      writes: true,
      expect: [201],
      observe: (res) => {
        const unit = dig(res.json, 'purchase_units', 0);
        return {
          order_status: dig(res.json, 'status'),
          link_rels: rels(res.json),
          approval_link_host: hostOf(approvalHref(res.json)),
          reference_id: dig(unit, 'reference_id'),
          custom_id: dig(unit, 'custom_id'),
          invoice_id: dig(unit, 'invoice_id'),
          payee_echoed: dig(unit, 'payee') !== undefined,
          debug_header_names: debugHeaders(res.headers),
          order_id_tail: idOnly(res.json)?.slice(-6),
        };
      },
    });
  // Step 6
  const c1 = await create(keys.c, 6, 'create order (key ' + keys.c + ')');
  if (!c1) return cy;
  cy.orderId = idOnly(c1.res.json);
  cy.approveUrl = approvalHref(c1.res.json);
  if (!cy.orderId) return cy;
  const id = cy.orderId;
  // Step 7
  await callRaw(ctx, recFor(7), {
    label: `${label}repeat create with the same key`,
    method: 'POST',
    path: '/v2/checkout/orders',
    headers: orderHeaders(keys.c),
    body,
    hint: 'docs_create_201_payer_action__create_order__1',
    writes: true,
    expect: [200, 201],
    observe: (res) => ({
      same_order_id: idOnly(res.json) === id,
      order_status: dig(res.json, 'status'),
    }),
  });
  // Step 8
  await callRaw(ctx, recFor(8), {
    label: `${label}GET order before approval`,
    method: 'GET',
    path: `/v2/checkout/orders/${id}`,
    hint: 'docs_get_order_created__get_order__1',
    writes: false,
    expect: [200],
    observe: (res) => ({
      order_status: dig(res.json, 'status'),
      payee_present: dig(res.json, 'purchase_units', 0, 'payee') !== undefined,
      amount: dig(res.json, 'purchase_units', 0, 'amount'),
      field_paths: shape(res.json),
    }),
  });
  // Step 9
  await callRaw(ctx, recFor(9), {
    label: `${label}capture before approval (key ${keys.early})`,
    method: 'POST',
    path: `/v2/checkout/orders/${id}/capture`,
    headers: orderHeaders(keys.early),
    body: {},
    hint: 'docs_capture_422_order_not_approved__capture_order__1',
    writes: true,
    expect: [422],
    observe: (res) => ({
      error_name: errName(res.json),
      issues: errIssue(res.json),
      debug_id: dig(res.json, 'debug_id'),
      debug_header_names: debugHeaders(res.headers),
    }),
  });
  // Step 10
  const r10 = recFor(10);
  const approved = await approveInBrowser(ctx, r10, cy.approveUrl, `${label}order`);
  if (!approved) {
    r10.notes.push('browser approval skipped; later steps for this order are skipped');
    return cy;
  }
  await callRaw(ctx, r10, {
    label: `${label}GET order after approval`,
    method: 'GET',
    path: `/v2/checkout/orders/${id}`,
    hint: 'docs_get_order_approved__get_order__1',
    writes: false,
    expect: [200],
    observe: (res) => ({
      order_status: dig(res.json, 'status'),
      expect_approved: dig(res.json, 'status') === 'APPROVED',
    }),
  });
  // Step 11
  const r11 = recFor(11);
  const cap = await callRaw(ctx, r11, {
    label: `${label}capture (key ${keys.cap})`,
    method: 'POST',
    path: `/v2/checkout/orders/${id}/capture`,
    headers: orderHeaders(keys.cap),
    body: {},
    hint: 'docs_capture_201__capture_order__1',
    writes: true,
    expect: [201],
    observe: (res) => {
      const c = firstCapture(res.json);
      return {
        order_status: dig(res.json, 'status'),
        capture_status: dig(c, 'status'),
        status_details_reason: dig(c, 'status_details', 'reason'),
        seller_receivable_breakdown: dig(c, 'seller_receivable_breakdown'),
        payee_present:
          dig(res.json, 'payee') !== undefined ||
          dig(res.json, 'purchase_units', 0, 'payee') !== undefined,
        capture_id_tail: str(dig(c, 'id'))?.slice(-6),
      };
    },
  });
  if (cap) {
    const c = firstCapture(cap.res.json);
    cy.captureId = str(dig(c, 'id'));
    cy.captureStatus = str(dig(c, 'status'));
  }
  const firstId = cy.captureId;
  await callRaw(ctx, r11, {
    label: `${label}repeat capture with the same key (${keys.cap})`,
    method: 'POST',
    path: `/v2/checkout/orders/${id}/capture`,
    headers: orderHeaders(keys.cap),
    body: {},
    hint: 'docs_capture_201__capture_order__1',
    writes: true,
    expect: [200],
    observe: (res) => ({ same_capture_id: str(dig(firstCapture(res.json), 'id')) === firstId }),
  });
  await callRaw(ctx, r11, {
    label: `${label}capture again with a new key (${keys.again})`,
    method: 'POST',
    path: `/v2/checkout/orders/${id}/capture`,
    headers: orderHeaders(keys.again),
    body: {},
    hint: 'docs_capture_422_order_already_captured__capture_order__1',
    writes: true,
    expect: [422],
    observe: (res) => ({
      error_name: errName(res.json),
      issues: errIssue(res.json),
      debug_id: dig(res.json, 'debug_id'),
    }),
  });
  // Step 12
  const r12 = recFor(12);
  await callRaw(ctx, r12, {
    label: `${label}GET order after capture`,
    method: 'GET',
    path: `/v2/checkout/orders/${id}`,
    hint: 'docs_get_order_completed__get_order__1',
    writes: false,
    expect: [200],
    observe: (res) => ({ order_status: dig(res.json, 'status'), field_paths: shape(res.json) }),
  });
  if (cy.captureId)
    await callRaw(ctx, r12, {
      label: `${label}GET capture`,
      method: 'GET',
      path: `/v2/payments/captures/${cy.captureId}`,
      hint: 'docs_get_capture__get_capture__1',
      writes: false,
      expect: [200],
      observe: (res) => ({
        capture_status: dig(res.json, 'status'),
        amount: dig(res.json, 'amount'),
        seller_receivable_breakdown: dig(res.json, 'seller_receivable_breakdown'),
        field_paths: shape(res.json),
      }),
    });
  return cy;
}

async function obtainToken(ctx: Ctx, rec: StepRec): Promise<void> {
  await call(ctx, rec, {
    label: 'request an access token',
    method: 'POST',
    path: '/v1/oauth2/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    hint: 'synthetic:token',
    writes: false,
    tokenCall: true,
    expect: [200],
    observe: (res) => {
      const scopes = (str(dig(res.json, 'scope')) ?? '').split(/\s+/).filter(Boolean);
      return {
        token_type: dig(res.json, 'token_type'),
        expires_in: dig(res.json, 'expires_in'),
        scope_list: scopes,
        payouts_in_scope: scopes.some((s) => /payout/i.test(s)),
      };
    },
  });
}

const STEP_TITLES: Array<[number, string, string, 'R' | 'W' | 'manual']> = [
  [1, 'dashboard', 'Dashboard: the REST app is sandbox (manual, see SPIKE-RUNBOOK.md)', 'manual'],
  [2, 'accounts', 'Sandbox accounts: country, currencies, receiving preference (manual)', 'manual'],
  [3, 'token', 'Token request', 'R'],
  [4, 'not-found', 'Not-found read (GET an order that does not exist)', 'R'],
  [5, 'webhooks', 'Webhooks page: is any webhook registered (operator note)', 'R'],
  [6, 'create-order', 'Create a one-unit USD order', 'W'],
  [7, 'create-replay', 'Repeat the create with the same key', 'W'],
  [8, 'get-before-approval', 'GET the order before approval', 'W'],
  [9, 'capture-before-approval', 'Capture before approval', 'W'],
  [10, 'approve-and-get', 'Approve in the browser, then GET the order', 'W'],
  [11, 'capture', 'Capture, repeat with the same key, capture with a new key', 'W'],
  [12, 'read-back', 'GET the order and the capture', 'W'],
  [13, 'eur-comparison', 'EUR comparison (only if the USD capture was PENDING)', 'W'],
  [14, 'refunds', 'Refund 1.00, then the remainder, with read-backs', 'W'],
  [15, 'two-unit', 'Two-unit order for the same payee', 'W'],
  [16, 'second-payee', 'Order for a second Business account (only if you made one)', 'W'],
  [17, 'late-capture', 'Late captures about 3 h and 7 h later', 'W'],
  [18, 'webhook-cert', 'Webhook certificate host (after hosting, MVP-C only)', 'W'],
];
const titleOf = (id: number) =>
  STEP_TITLES.find((s) => s[0] === id) as [number, string, string, 'R' | 'W' | 'manual'];

function saveStep(ctx: Ctx, rec: StepRec): void {
  const doc = ctx.redactor.redact({
    meta: {
      step: rec.id,
      title: rec.title,
      source: ctx.cfg.dryRun
        ? 'dry-run-replay-of-docs-examples (not PayPal evidence)'
        : 'owner-spike-run (redacted)',
      dry_run: ctx.cfg.dryRun,
      operator: ctx.cfg.operator,
      approval_ref: ctx.cfg.approvalRef,
      status: rec.status,
    },
    notes: rec.notes,
    extra: rec.extra,
    calls: rec.calls,
  });
  const text = JSON.stringify(doc, null, 2) + '\n';
  assertClean(ctx, text);
  ctx.deps.fs.writeFile(join(ctx.cfg.outDir, `${pad(rec.id)}-${rec.slug}.json`), text);
}
function assertClean(ctx: Ctx, text: string): void {
  for (const s of ctx.redactor.secrets())
    if (text.includes(s))
      throw new RunStop(3, 'a secret survived redaction; run stopped, nothing more written');
  if (
    /Bearer\s+(?!\[)[A-Za-z0-9._~+/=-]{8,}/.test(text) ||
    /Basic\s+(?!\[)[A-Za-z0-9+/=]{12,}/.test(text)
  )
    throw new RunStop(3, 'an authorization value survived redaction; run stopped');
}

async function step(ctx: Ctx, id: number, body: (rec: StepRec) => Promise<void>): Promise<void> {
  const [, slug, title, part] = titleOf(id);
  const rec: StepRec = { id, slug, title, part, status: 'done', calls: [], notes: [], extra: {} };
  ctx.steps.push(rec);
  try {
    await body(rec);
    if (
      rec.calls.length === 0 &&
      rec.status === 'done' &&
      part !== 'manual' &&
      rec.notes.length > 0 &&
      !rec.extra['operator_note']
    )
      rec.status = 'declined';
  } catch (e) {
    rec.status = 'aborted';
    rec.notes.push(e instanceof RunStop ? e.reason : 'aborted');
    saveStep(ctx, rec);
    throw e;
  }
  saveStep(ctx, rec);
}

function summaryLine(rec: StepRec): string[] {
  const lines: string[] = [];
  for (const c of rec.calls) {
    const o = Object.entries(c.observations)
      .filter(([k, v]) => k !== 'http_status' && k !== 'field_paths' && v !== undefined)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`.slice(0, 300))
      .join('; ');
    const ok =
      c.matches_expectation === null
        ? ''
        : c.matches_expectation
          ? ' [as expected]'
          : ` [UNEXPECTED, expected ${c.expected_status?.join('/')}]`;
    lines.push(`- ${c.label}: HTTP ${c.response?.status ?? '?'}${ok}${o ? `; ${o}` : ''}`);
  }
  for (const n of rec.notes) lines.push(`- note: ${n}`);
  for (const [k, v] of Object.entries(rec.extra)) lines.push(`- ${k}: ${JSON.stringify(v)}`);
  return lines;
}

function writeSummary(ctx: Ctx, stop: RunStop | null): string {
  const lines: string[] = ['# Spike run summary', ''];
  if (ctx.cfg.dryRun) {
    lines.push(
      'DRY RUN: replay of the bundled docs examples through the same code. This is not PayPal evidence.',
      '',
    );
  } else {
    lines.push(
      `Run by ${ctx.cfg.operator} against the PayPal sandbox. Approval ref: ${ctx.cfg.approvalRef}.`,
      '',
    );
  }
  lines.push(
    `- Date: ${ctx.deps.nowIso().slice(0, 10)}`,
    `- Mode: ${ctx.cfg.mode}`,
    `- Calls used: ${ctx.calls} of ${ctx.cap}`,
  );
  lines.push(`- Ended: ${stop ? stop.reason : 'normally'}`, '');
  const all = [...Array(18).keys()].map((i) => i + 1);
  for (const id of all) {
    const rec = ctx.steps.find((s) => s.id === id);
    const [, , title, part] = titleOf(id);
    lines.push(`## Step ${id} - ${title}`);
    if (!rec) {
      const why =
        part === 'manual'
          ? 'manual step, done in the dashboard (see docs/owner/SPIKE-RUNBOOK.md)'
          : `not run (mode ${ctx.cfg.mode})`;
      lines.push(`- ${why}`, '');
      continue;
    }
    lines.push(
      `- status: ${rec.status}; file: ${pad(rec.id)}-${rec.slug}.json`,
      ...summaryLine(rec),
      '',
    );
  }
  const text = lines.join('\n');
  const clean = ctx.redactor.text(text);
  assertClean(ctx, clean);
  ctx.deps.fs.writeFile(join(ctx.cfg.outDir, 'summary.md'), clean);
  return clean;
}

function pickDir(deps: Deps, base: string): string {
  if (!deps.fs.exists(join(base, 'summary.md'))) return base;
  for (let i = 2; i < 100; i++) {
    const d = `${base}-${i}`;
    if (!deps.fs.exists(join(d, 'summary.md'))) return d;
  }
  throw new SpikeError('output_dir_full', 'too many earlier runs on this date');
}

export interface RunOptions {
  callCap?: number;
}
export interface RunResult {
  exitCode: number;
  calls: number;
  outDir: string;
}

export async function runSpike(
  cfg0: Config,
  deps: Deps,
  wire: Wire,
  opts: RunOptions = {},
): Promise<RunResult> {
  const cfg: Config = { ...cfg0, outDir: pickDir(deps, cfg0.outDir) };
  deps.fs.mkdirp(cfg.outDir);
  const redactor = createRedactor();
  if (!cfg.dryRun) {
    redactor.addSecret(cfg.clientId);
    redactor.addSecret(cfg.clientSecret);
    redactor.addSecret(Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'));
  }
  const iso = deps.nowIso();
  const ctx: Ctx = {
    cfg,
    deps,
    wire,
    redactor,
    cap: Math.min(opts.callCap ?? CALL_CAP, CALL_CAP),
    calls: 0,
    token: null,
    tokenExpiresMs: 0,
    steps: [],
    runTag: iso.replace(/[-:]/g, '').slice(0, 13).replace('T', ''),
  };
  say(ctx, `Output directory: ${cfg.outDir}`);
  say(
    ctx,
    cfg.dryRun
      ? 'DRY RUN: no network, bundled fixtures only.'
      : 'Sandbox calls only. Answer q at any prompt to stop.',
  );
  let stop: RunStop | null = null;
  const mode = cfg.mode;
  const doRead = mode === 'read' || mode === 'all';
  const doWrite = mode === 'write' || mode === 'all';
  try {
    await step(ctx, 3, async (rec) => {
      await obtainToken(ctx, rec);
    });
    if (doRead) {
      await step(ctx, 4, async (rec) => {
        await callRaw(ctx, rec, {
          label: 'GET an order that does not exist',
          method: 'GET',
          path: '/v2/checkout/orders/AAAAAAAAAAAAAAAAA',
          hint: 'docs_get_order_404__get_order__1',
          writes: false,
          expect: [404],
          observe: (res) => ({
            error_name: errName(res.json),
            issues: errIssue(res.json),
            debug_id: dig(res.json, 'debug_id'),
            debug_header_names: debugHeaders(res.headers),
          }),
        });
      });
      await step(ctx, 5, async (rec) => {
        const a = await askText(
          ctx,
          'Webhooks page: is any webhook registered? Type none, some or unsure (empty to skip): ',
          'none',
        );
        const v = a.toLowerCase();
        if (v === 'none' || v === 'some' || v === 'unsure') {
          rec.extra['operator_note'] = ctx.cfg.dryRun ? 'none (dry-run placeholder)' : v;
          rec.extra['expected'] = 'none';
        } else rec.notes.push('no answer recorded');
      });
    }
    if (doWrite) {
      let usd: Cycle | undefined;
      const recs = new Map<number, StepRec>();
      const recFor: RecFor = (n) => {
        const have = recs.get(n);
        if (have) return have;
        const [, slug, title, part] = titleOf(n);
        const rec: StepRec = {
          id: n,
          slug,
          title,
          part,
          status: 'done',
          calls: [],
          notes: [],
          extra: {},
        };
        recs.set(n, rec);
        ctx.steps.push(rec);
        return rec;
      };
      try {
        usd = await cycle(
          ctx,
          recFor,
          'USD',
          { c: KEYS.K1, early: KEYS.K2, cap: KEYS.K3, again: KEYS.K4 },
          '',
        );
      } finally {
        for (const rec of recs.values()) saveStep(ctx, rec);
      }
      // Step 13
      if (usd.captureStatus === 'PENDING') {
        await step(ctx, 13, async (rec) => {
          rec.extra['reason'] = 'the USD capture was PENDING';
          if (
            !(await confirm(
              ctx,
              'The USD capture was PENDING. Repeat steps 6 to 12 in EUR for comparison? [y/N] ',
            ))
          ) {
            rec.notes.push('EUR comparison declined by operator');
            return;
          }
          await cycle(
            ctx,
            () => rec,
            'EUR',
            { c: KEYS.E1, early: KEYS.E2, cap: KEYS.E3, again: KEYS.E4 },
            'EUR: ',
          );
        });
      } else {
        await step(ctx, 13, async (rec) => {
          rec.status = 'not_applicable';
          rec.notes.push(
            usd?.captureStatus
              ? `USD capture status was ${usd.captureStatus}, not PENDING`
              : 'no USD capture was made',
          );
        });
      }
      // Step 14
      await step(ctx, 14, async (rec) => {
        const capId = usd?.captureId;
        const orderId = usd?.orderId;
        if (!capId || !orderId) {
          rec.status = 'skipped';
          rec.notes.push('needs the capture from step 11');
          return;
        }
        const refundObs = (res: Res): Obs => ({
          refund_status: dig(res.json, 'status'),
          amount: dig(res.json, 'amount'),
          link_rels: rels(res.json),
          has_up_link: rels(res.json).includes('up'),
          total_refunded_amount: dig(res.json, 'seller_payable_breakdown', 'total_refunded_amount'),
          refund_id_tail: idOnly(res.json)?.slice(-6),
        });
        const refund = async (label: string, key: string, body: unknown) => {
          const r = await callRaw(ctx, rec, {
            label,
            method: 'POST',
            path: `/v2/payments/captures/${capId}/refund`,
            headers: { 'paypal-request-id': key },
            body,
            hint: 'docs_refund_201__refund_capture__1',
            writes: true,
            expect: [201],
            observe: refundObs,
          });
          const rid = r ? idOnly(r.res.json) : undefined;
          if (rid)
            await callRaw(ctx, rec, {
              label: `GET refund after ${label}`,
              method: 'GET',
              path: `/v2/payments/refunds/${rid}`,
              hint: 'docs_get_refund__get_refund__1',
              writes: false,
              expect: [200],
              observe: refundObs,
            });
        };
        await refund(`refund 1.00 (key ${KEYS.K5})`, KEYS.K5, {
          amount: { currency_code: 'USD', value: '1.00' },
        });
        await refund(`refund the remainder, empty body (key ${KEYS.K6})`, KEYS.K6, {});
        await callRaw(ctx, rec, {
          label: 'GET capture after refunds',
          method: 'GET',
          path: `/v2/payments/captures/${capId}`,
          hint: 'docs_get_capture__get_capture__1',
          writes: false,
          expect: [200],
          observe: (res) => ({
            capture_status: dig(res.json, 'status'),
            total_refunded_amount: dig(
              res.json,
              'seller_receivable_breakdown',
              'total_refunded_amount',
            ),
            link_rels: rels(res.json),
          }),
        });
        await callRaw(ctx, rec, {
          label: 'GET order after refunds',
          method: 'GET',
          path: `/v2/checkout/orders/${orderId}`,
          hint: 'docs_get_order_completed__get_order__1',
          writes: false,
          expect: [200],
          observe: (res) => ({ order_status: dig(res.json, 'status') }),
        });
      });
      // Step 15
      await step(ctx, 15, async (rec) => {
        const body = orderBody(ctx, 'USD', [
          { ref: 'spike-A', invoice: `spike-inv-${ctx.runTag}-2A` },
          { ref: 'spike-B', invoice: `spike-inv-${ctx.runTag}-2B` },
        ]);
        const c = await callRaw(ctx, rec, {
          label: `create a two-unit order (key ${KEYS.K7})`,
          method: 'POST',
          path: '/v2/checkout/orders',
          headers: orderHeaders(KEYS.K7),
          body,
          hint: 'docs_create_201_payer_action__create_order__1',
          writes: true,
          expect: [201],
          observe: (res) => ({
            order_status: dig(res.json, 'status'),
            units: arr(dig(res.json, 'purchase_units')).length,
            link_rels: rels(res.json),
          }),
        });
        const id = c ? idOnly(c.res.json) : undefined;
        if (!c || !id) return;
        if (!(await approveInBrowser(ctx, rec, approvalHref(c.res.json), 'two-unit order'))) {
          rec.notes.push('browser approval skipped');
          return;
        }
        await callRaw(ctx, rec, {
          label: 'GET two-unit order after approval',
          method: 'GET',
          path: `/v2/checkout/orders/${id}`,
          hint: 'docs_get_order_approved__get_order__1',
          writes: false,
          expect: [200],
          observe: (res) => ({ order_status: dig(res.json, 'status') }),
        });
        await callRaw(ctx, rec, {
          label: `capture the two-unit order (key ${KEYS.K8})`,
          method: 'POST',
          path: `/v2/checkout/orders/${id}/capture`,
          headers: orderHeaders(KEYS.K8),
          body: {},
          hint: 'docs_capture_201__capture_order__1',
          writes: true,
          expect: [201, 207],
          observe: (res) => ({
            order_status: dig(res.json, 'status'),
            per_unit: arr(dig(res.json, 'purchase_units')).map((u) => ({
              reference_id: dig(u, 'reference_id'),
              capture_status: dig(u, 'payments', 'captures', 0, 'status'),
              capture_amount: dig(u, 'payments', 'captures', 0, 'amount'),
            })),
          }),
        });
      });
      // Step 16
      await step(ctx, 16, async (rec) => {
        const m = await askText(
          ctx,
          'Step 16 needs a SECOND Business sandbox account. Enter its merchant id (13 capital letters or digits), or press Enter to skip: ',
          '',
        );
        if (!/^[A-Z0-9]{13}$/.test(m)) {
          rec.status = 'skipped';
          rec.notes.push(
            m === ''
              ? 'skipped: no second Business account'
              : 'skipped: that is not a 13 character merchant id',
          );
          return;
        }
        ctx.redactor.addSecret(m);
        await callRaw(ctx, rec, {
          label: `create an order whose payee is the second account (key ${KEYS.K9})`,
          method: 'POST',
          path: '/v2/checkout/orders',
          headers: orderHeaders(KEYS.K9),
          body: orderBody(ctx, 'USD', [
            { ref: 'spike-A', invoice: `spike-inv-${ctx.runTag}-16`, payee: m },
          ]),
          hint: 'docs_create_201_payer_action__create_order__1',
          writes: true,
          expect: [201, 422],
          observe: (res) => ({
            order_status: dig(res.json, 'status'),
            error_name: errName(res.json),
            issues: errIssue(res.json),
            debug_id: dig(res.json, 'debug_id'),
          }),
        });
      });
      // Step 17
      await step(ctx, 17, async (rec) => {
        if (
          !(await confirm(
            ctx,
            'Step 17 takes about 7 hours with this terminal left open (captures about 3 h and 7 h after approval). Run it now? [y/N] ',
          ))
        ) {
          rec.status = 'skipped';
          rec.notes.push('skipped by operator');
          return;
        }
        const mk = async (key: string, tag: string) => {
          const r = await callRaw(ctx, rec, {
            label: `create order ${tag} (key ${key})`,
            method: 'POST',
            path: '/v2/checkout/orders',
            headers: orderHeaders(key),
            body: orderBody(ctx, 'USD', [
              { ref: 'spike-A', invoice: `spike-inv-${ctx.runTag}-17${tag}` },
            ]),
            hint: 'docs_create_201_payer_action__create_order__1',
            writes: true,
            expect: [201],
            observe: (res) => ({ order_status: dig(res.json, 'status') }),
          });
          return r ? { id: idOnly(r.res.json), url: approvalHref(r.res.json) } : undefined;
        };
        const x1 = await mk(KEYS.K10, 'X1');
        const x2 = await mk(KEYS.K11, 'X2');
        if (!x1?.id || !x2?.id) return;
        await callRaw(ctx, rec, {
          label: `capture X2 before approval (key ${KEYS.K12}), the failed earlier attempt`,
          method: 'POST',
          path: `/v2/checkout/orders/${x2.id}/capture`,
          headers: orderHeaders(KEYS.K12),
          body: {},
          hint: 'docs_capture_422_order_not_approved__capture_order__1',
          writes: true,
          expect: [422],
          observe: (res) => ({ error_name: errName(res.json), issues: errIssue(res.json) }),
        });
        const okA = await approveInBrowser(ctx, rec, x1.url, 'order X1');
        const okB = await approveInBrowser(ctx, rec, x2.url, 'order X2');
        if (!okA || !okB) {
          rec.notes.push('approval skipped; the late captures were not attempted');
          return;
        }
        const t0 = Date.parse(ctx.deps.nowIso());
        rec.extra['approved_at'] = ctx.deps.nowIso();
        const waitFor = async (minutes: number, what: string) => {
          const q = `Wait until about ${minutes / 60} hours after approval, then type y to capture ${what}. Now: ${ctx.deps.nowIso()}. y/N: `;
          if (!(await confirm(ctx, q))) return false;
          const elapsed = Math.round((Date.parse(ctx.deps.nowIso()) - t0) / 60_000);
          rec.extra[`elapsed_minutes_${what}`] = elapsed;
          if (
            !ctx.cfg.dryRun &&
            elapsed < minutes * 0.9 &&
            !(await confirm(ctx, `Only ${elapsed} minutes have passed. Capture anyway? [y/N] `))
          )
            return false;
          return true;
        };
        if (await waitFor(180, 'X1'))
          await callRaw(ctx, rec, {
            label: `capture X1 about 3 h later (key ${KEYS.K13})`,
            method: 'POST',
            path: `/v2/checkout/orders/${x1.id}/capture`,
            headers: orderHeaders(KEYS.K13),
            body: {},
            hint: 'docs_capture_201__capture_order__1',
            writes: true,
            expect: [201],
            observe: (res) => ({
              order_status: dig(res.json, 'status'),
              capture_status: dig(firstCapture(res.json), 'status'),
              error_name: errName(res.json),
              issues: errIssue(res.json),
            }),
          });
        if (await waitFor(420, 'X2'))
          await callRaw(ctx, rec, {
            label: `capture X2 about 7 h later with the earlier failed key (${KEYS.K12})`,
            method: 'POST',
            path: `/v2/checkout/orders/${x2.id}/capture`,
            headers: orderHeaders(KEYS.K12),
            body: {},
            hint: 'docs_capture_201__capture_order__1',
            writes: true,
            expect: [201, 422],
            observe: (res) => ({
              order_status: dig(res.json, 'status'),
              capture_status: dig(firstCapture(res.json), 'status'),
              error_name: errName(res.json),
              issues: errIssue(res.json),
              debug_id: dig(res.json, 'debug_id'),
            }),
          });
      });
      await step(ctx, 18, async (rec) => {
        rec.status = 'deferred';
        rec.notes.push(
          'after hosting (MVP-C) only: register a webhook, trigger one capture, record the paypal-cert-url host and path. The kit makes no webhook call.',
        );
      });
    }
  } catch (e) {
    if (e instanceof RunStop) stop = e;
    else throw e;
  }
  const exitCode = stop ? stop.exitCode : 0;
  if (stop?.exitCode !== 3) {
    try {
      writeSummary(ctx, stop);
    } catch (e) {
      if (e instanceof RunStop) stop = e;
      else throw e;
    }
  }
  say(ctx, '');
  say(ctx, `Calls used: ${ctx.calls} of ${ctx.cap}`);
  say(ctx, stop ? `Stopped: ${stop.reason}` : 'Finished.');
  say(ctx, `Output: ${cfg.outDir}`);
  return { exitCode: stop ? stop.exitCode : exitCode, calls: ctx.calls, outDir: cfg.outDir };
}

// ---- main -----------------------------------------------------------------------------------------
const USAGE = `UnitMarket sandbox spike kit
  node tools/spike-kit/src/spike.ts --dry-run [--out <dir>]    replay bundled docs examples, no network
  node tools/spike-kit/src/spike.ts [--out <dir>]              owner only, real sandbox calls

A real run needs, set in this terminal only (never in a file):
  SPIKE_OPERATOR      vikram or sakthi
  SPIKE_APPROVAL_REF  a decision-log row id, for example D-024, that authorises the spike
  SPIKE_MODE          read or write
  PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   the sandbox REST app credentials
and an interactive terminal, with CI unset. Output goes to ~/unitmarket-spike/<date>/.
Exit codes: 0 done, 1 quit, 2 refused, 3 redaction failure, 4 transport error, 5 call cap.`;

export async function main(deps: Deps): Promise<number> {
  const args = parseArgs(deps.argv);
  if (args?.help) {
    deps.out(USAGE);
    return 0;
  }
  const pre = preflight(deps);
  if (!pre.ok) {
    deps.err(`REFUSED ${pre.code}: ${pre.message}`);
    return 2;
  }
  const survivors = redactionSelfTest(createRedactor);
  if (survivors.length > 0) {
    deps.err(
      `REDACTION SELF-TEST FAILED, run stopped before any call. Survivors: ${survivors.join(', ')}`,
    );
    return 3;
  }
  const cfg = pre.cfg;
  let wire: Wire;
  if (cfg.dryRun) wire = createReplayWire(deps.fixtureDir, deps.readText);
  else if (deps.fetchImpl)
    wire = createSpikeFetchWire(deps.fetchImpl, () =>
      networkOverride(deps.env, deps.execArgv ?? []),
    );
  else {
    deps.err('REFUSED no_transport: no fetch function available');
    return 2;
  }
  try {
    return (await runSpike(cfg, deps, wire)).exitCode;
  } catch (e) {
    deps.err(
      `ERROR ${e instanceof SpikeError ? e.message : e instanceof Error ? e.name : 'unknown'}`,
    );
    return 4;
  }
}

// ---- entry point (never runs when imported) -------------------------------------------------------
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const { createInterface } = await import('node:readline');
  const { readFileSync, mkdirSync, writeFileSync, existsSync, realpathSync } =
    await import('node:fs');
  const { homedir, tmpdir } = await import('node:os');
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  // SEAL2 M1: a real run proves docs/decision-log.md equals HEAD with local git (never a dry run).
  const git = dry ? null : await import('./git-head.ts');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const here = dirname(new URL(import.meta.url).pathname);
  const repoRoot = resolve(here, '..', '..', '..');
  const deps: Deps = {
    env: process.env,
    argv,
    stdinIsTTY: process.stdin.isTTY === true,
    execArgv: process.execArgv,
    nowIso: () => new Date().toISOString(),
    homeDir: homedir(),
    tmpDir: tmpdir(),
    repoRoot,
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    fixtureDir: join(repoRoot, 'fixtures', 'paypal', 'docs-examples'),
    ask: (q) => new Promise((res) => rl.question(q, res)),
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    fs: {
      mkdirp: (p) => void mkdirSync(p, { recursive: true, mode: 0o700 }),
      writeFile: (p, t) => writeFileSync(p, t, { mode: 0o600 }),
      exists: (p) => existsSync(p),
      realpath: (p) => realpathSync(p),
    },
    ...(git === null
      ? {}
      : { gitShowHead: (rel: string) => git.gitShowHead(repoRoot, rel, process.env) }),
    ...(dry ? {} : { fetchImpl: fetch as unknown as FetchLike }),
  };
  const code = await main(deps);
  rl.close();
  process.exitCode = code;
}
