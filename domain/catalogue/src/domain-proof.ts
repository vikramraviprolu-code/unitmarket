// POB-I1 (D-089, journey J7): a publisher proves that it controls a web address before UnitMarket reads
// anything from it. The publisher asks for a domain and is shown a token ONCE (only its hash is kept). It then
// puts the token in a <meta name="unitmarket-verify" content="..."> tag in the head of the front page, or
// serves it alone at /.well-known/unitmarket-verify.txt. A check fetches those two fixed paths, one guarded
// GET each, on that host only, and nothing else is ever fetched from a host that is not verified.
//
// The page readers are strict because the page is hostile input: a token that only appears where a stranger
// could have put it (a comment, a script, a visitor's post in the body, a twin tag) proves nothing. See
// html-scan.ts for what counts as a live tag. The database part follows the rules of the other catalogue
// writes: the actor is the publisher in the session, every query filters by its id, and the host table has
// one verified owner per host.
import { ok, err } from '@umsbx/contracts';
import type { Actor, Result } from '@umsbx/contracts';
import { scanHtml } from './html-scan';
import { fetchChecked, sha256Text } from './import-fetch';
import type { ImportDeps, ImportError } from './import-types';

export const PROOF_META_NAME = 'unitmarket-verify';
export const WELL_KNOWN_PATH = '/.well-known/unitmarket-verify.txt';
/** The only two paths ever fetched from a host that is not verified yet. */
export const PROOF_PATHS: readonly string[] = ['/', WELL_KNOWN_PATH];
export const MAX_DOMAINS_PER_PUBLISHER = 10;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

// ---------------------------------------------------------------------------------------------
// Pure readers

const PRIVATE_SUFFIXES = [
  'localhost',
  'internal',
  'local',
  'localdomain',
  'lan',
  'intranet',
  'private',
  'home.arpa',
];

/** A lower case DNS name with at least two labels, not a number, not localhost. Null otherwise. */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 254) return null;
  let h = raw.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length < 4 || h.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h))
    return null;
  // A name the URL parser would read as an address (last label a decimal or 0x number) is never a name.
  if (/\.(0x[0-9a-f]*|[0-9]+)$/.test(h)) return null;
  // Names that only exist inside a network are never a publisher's public address.
  if (PRIVATE_SUFFIXES.some((x) => h === x || h.endsWith(`.${x}`))) return null;
  return h;
}

export interface WebAddress {
  host: string;
  /** Path and query, starting with '/'. No fragment. */
  path: string;
  /** https://host + path, the address as the import will ask for it. */
  url: string;
}

/**
 * What a publisher may type: an https address with a plain name, no user, no port other than 443. The
 * transport guard checks the same things again on every fetch; this is the first, friendlier check.
 */
export function parseWebAddress(raw: unknown): WebAddress | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes('\\')) return null;
  const m = /^https:\/\/([^/?#]*)([^#]*)(?:#.*)?$/i.exec(raw);
  if (m === null) return null;
  const authority = m[1]!;
  if (authority.includes('@') || authority.startsWith('[')) return null;
  let hostText = authority;
  const colon = authority.lastIndexOf(':');
  if (colon >= 0) {
    if (authority.slice(colon + 1) !== '443') return null;
    hostText = authority.slice(0, colon);
  }
  const host = normalizeHost(hostText);
  if (host === null) return null;
  const rest = m[2]!;
  const path = rest === '' ? '/' : rest.startsWith('/') ? rest : `/${rest}`;
  return { host, path, url: `https://${host}${path}` };
}

/**
 * The token of the proof meta tag, or null. Exactly one live tag with name="unitmarket-verify" may exist in
 * the head (property=, itemprop= and the rest do not count; two tags fail); its content must have the shape
 * of a token. See html-scan.ts for what is live.
 */
export function readProofToken(html: unknown): string | null {
  if (typeof html !== 'string') return null;
  const scan = scanHtml(html, { head_only: true, ld: false });
  const hits = scan.metas.filter((m) => m['name']?.toLowerCase() === PROOF_META_NAME);
  if (hits.length !== 1) return null;
  const content = hits[0]!['content'];
  return content !== undefined && TOKEN_SHAPE.test(content) ? content : null;
}

/** The token of the well-known file: one line, nothing else (a trailing line break is fine). */
export function readWellKnownToken(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 512) return null;
  const line = text.replace(/\r?\n$/, '');
  return TOKEN_SHAPE.test(line) ? line : null;
}

// ---------------------------------------------------------------------------------------------
// The proof: two fixed paths

export type ProofResult =
  { kind: 'ok' } | { kind: 'missing' } | { kind: 'refused'; reason: string } | { kind: 'paused' };

/** Network refusals that would repeat on the second path: do not ask twice. */
const HARD = new Set(['private_address', 'dns_failed', 'timeout', 'network', 'pin_mismatch']);

/**
 * Fetches the front page, then the well-known file, and compares the hash of the token found with the stored
 * hash. Stops at the first proof. Each fetch goes through the may-fetch check. `missing`: a page was read and
 * holds no proof. `refused`: no page could be read at all (first reason kept).
 */
export async function proveDomain(
  deps: Pick<ImportDeps, 'fetcher' | 'mayFetch'>,
  host: string,
  token_hash: string,
): Promise<ProofResult> {
  let read = false;
  let first: string | null = null;
  for (const path of PROOF_PATHS) {
    const r = await fetchChecked(deps, host, `https://${host}${path}`, 'text');
    if (r.kind === 'paused' || r.kind === 'check_failed') return { kind: 'paused' };
    if (r.kind === 'off') return { kind: 'refused', reason: 'import_off' };
    if (r.kind === 'refused') {
      first ??= r.reason;
      if (HARD.has(r.reason)) break;
      continue;
    }
    read = true;
    const token = path === '/' ? readProofToken(r.body) : readWellKnownToken(r.body);
    if (token !== null && (await sha256Text(token)) === token_hash) return { kind: 'ok' };
  }
  return read ? { kind: 'missing' } : { kind: 'refused', reason: first ?? 'network' };
}

// ---------------------------------------------------------------------------------------------
// The database part

const fail = (code: ImportError['code'], detail?: string): Result<never, ImportError> =>
  err(detail === undefined ? { code } : { code, detail });
const isUnique = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

export interface DomainView {
  host: string;
  state: 'pending' | 'verified';
  requested_at: string;
  verified_at: string | null;
}

/** The own domains of the signed-in publisher, never the token or its hash. Null for any other actor. */
export async function listDomains(
  db: ImportDeps['db'],
  actor: Actor,
): Promise<DomainView[] | null> {
  if (actor.kind !== 'publisher') return null;
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT host, state, requested_at, verified_at FROM publisher_domains WHERE publisher_id = $1 ORDER BY host',
    [actor.publisher_id],
  );
  return rows.map((r) => ({
    host: r.host as string,
    state: r.state as 'pending' | 'verified',
    requested_at: iso(r.requested_at),
    verified_at: r.verified_at == null ? null : iso(r.verified_at),
  }));
}

/**
 * The publisher asks to prove a domain. Gives a new token (shown once; only its hash is stored) and a
 * pending row, or, when the host is already this publisher's verified domain, says so with no token. Asking
 * again for a pending host replaces the token, so the old one stops working. A host that another publisher
 * has verified is host_taken. At most 10 domains per publisher.
 */
export async function requestDomain(
  deps: ImportDeps,
  actor: Actor,
  input: { host: string },
): Promise<
  Result<{ host: string; state: 'pending' | 'verified'; token: string | null }, ImportError>
> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const host = normalizeHost(input.host);
  if (host === null) return fail('invalid_host');
  const token = `umv-${deps.ids.nonce()}`;
  const hash = await sha256Text(token);
  const id = `pdm_${deps.ids.nonce()}`;
  return deps.db.transaction(async (tx) => {
    // The publisher row is locked: two requests of one publisher take turns, so the cap holds.
    const pub = await tx.query<{ status: string }>(
      'SELECT status FROM publishers WHERE id = $1 FOR UPDATE',
      [actor.publisher_id],
    );
    if (pub.rows[0] === undefined) return fail('not_publisher');
    if (pub.rows[0].status !== 'active') return fail('publisher_not_active');
    const at = deps.clock.now().toISOString();
    const own = await tx.query<{ id: string; state: string }>(
      'SELECT id, state FROM publisher_domains WHERE publisher_id = $1 AND host = $2',
      [actor.publisher_id, host],
    );
    const row = own.rows[0];
    if (row !== undefined && row.state === 'verified')
      return ok({ host, state: 'verified' as const, token: null });
    const taken = await tx.query(
      `SELECT 1 AS x FROM publisher_domains WHERE host = $1 AND state = 'verified' AND publisher_id <> $2`,
      [host, actor.publisher_id],
    );
    if (taken.rows.length > 0) return fail('host_taken');
    let target = id;
    if (row !== undefined) {
      target = row.id;
      await tx.query(
        `UPDATE publisher_domains SET token_hash = $2, requested_at = $3, updated_at = $3 WHERE id = $1 AND state = 'pending'`,
        [row.id, hash, at],
      );
    } else {
      const count = await tx.query<{ c: string | number }>(
        'SELECT count(*) AS c FROM publisher_domains WHERE publisher_id = $1',
        [actor.publisher_id],
      );
      if (Number(count.rows[0]?.c ?? 0) >= MAX_DOMAINS_PER_PUBLISHER)
        return fail('too_many_domains');
      await tx.query(
        `INSERT INTO publisher_domains (id, publisher_id, host, token_hash, state, requested_at, verified_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'pending',$5,NULL,$5,$5)`,
        [id, actor.publisher_id, host, hash, at],
      );
    }
    // The token never goes into the audit row.
    await deps.audit.record(tx, {
      actor,
      action: 'domain.requested',
      target,
      reason: null,
      detail: { host },
    });
    return ok({ host, state: 'pending' as const, token });
  });
}

/**
 * Looks for the proof on the host (the two fixed paths) and, when the stored token is there, marks the domain
 * verified. proof_missing: a page was read and holds no proof. proof_refused: no page could be read (the
 * guard's fixed word is in `detail`). paused and import_off: nothing was fetched.
 */
export async function checkDomain(
  deps: ImportDeps,
  actor: Actor,
  input: { host: string },
): Promise<Result<{ host: string; state: 'verified' }, ImportError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const host = normalizeHost(input.host);
  if (host === null) return fail('invalid_host');
  const found = await deps.db.query<{
    id: string;
    state: string;
    token_hash: string;
    status: string;
  }>(
    `SELECT d.id, d.state, d.token_hash, p.status FROM publisher_domains d JOIN publishers p ON p.id = d.publisher_id
      WHERE d.publisher_id = $1 AND d.host = $2`,
    [actor.publisher_id, host],
  );
  const row = found.rows[0];
  if (row === undefined) return fail('not_found');
  if (row.status !== 'active') return fail('publisher_not_active');
  if (row.state === 'verified') return ok({ host, state: 'verified' as const });
  if (deps.fetcher === null) return fail('import_off');
  const proof = await proveDomain(deps, host, row.token_hash);
  if (proof.kind === 'paused') return fail('paused');
  if (proof.kind === 'refused') return fail('proof_refused', proof.reason);
  if (proof.kind === 'missing') return fail('proof_missing');
  try {
    await deps.db.transaction(async (tx) => {
      const at = deps.clock.now().toISOString();
      const upd = await tx.query(
        `UPDATE publisher_domains SET state = 'verified', verified_at = $2, updated_at = $2
          WHERE id = $1 AND state = 'pending' RETURNING id`,
        [row.id, at],
      );
      if (upd.rows.length === 0) return;
      await deps.audit.record(tx, {
        actor,
        action: 'domain.verified',
        target: row.id,
        reason: null,
        detail: { host },
      });
    });
  } catch (e) {
    if (isUnique(e)) return fail('host_taken');
    throw e;
  }
  return ok({ host, state: 'verified' as const });
}
