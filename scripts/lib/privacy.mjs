// OPS-PRIV (PRIV-3, PRIV-4), docs/specs/ops-privacy-export-delete.md: the body of the operator privacy script.
//
//   runExport  one JSON document with the rows a buyer owns; reads only, filters every query by the buyer id
//   runDelete  pseudonymises the buyer's personal fields in one transaction with one audit row; never deletes a row
//
// Plain JavaScript with no import: the caller (scripts/lib/privacy-main.mjs) passes the database, the clock
// and the audit sink in, so a state test can run this on an in-memory database. Nothing here reads the
// environment, a file or the network. The ledger, receipts, approvals, access events, provider calls and
// the audit log are append-only (their triggers refuse a change) and are never touched.
import { createHash } from 'node:crypto';

const AI_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_REMOTE',
  'AI_AGENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
];
const CI_MARKERS = ['CI', 'GITHUB_ACTIONS'];
const set = (v) => v !== undefined && v !== '';
const err = (error) => ({ ok: false, error });
const ok = (value) => ({ ok: true, value });

export const REMOVED_TEXT = '[removed]';

/** The pseudonym a deleted buyer carries: `deleted-` and the first 8 hex of sha256(buyer id). */
export const pseudonymFor = (buyerId) =>
  `deleted-${createHash('sha256').update(buyerId).digest('hex').slice(0, 8)}`;

/**
 * Both commands run from a person's terminal only. CI and AI sessions are named first so a pipeline
 * with no terminal says why. Returns the refusal text or null.
 */
export function refusal(tty) {
  if (CI_MARKERS.some((n) => set(tty.env[n]))) return 'CI';
  if (AI_MARKERS.some((n) => set(tty.env[n]))) return 'AI session';
  if (tty.isTTY !== true) return 'not a terminal';
  return null;
}

// Columns left out of the export: a secret-like value the buyer does not need, or another party's payout id.
const OMIT = {
  approvals: ['nonce'],
  order_units: ['payee_merchant_id'],
};

// Tables that hold a token hash, a CSRF hash, a stored response body or an approval link are exported by
// an explicit column list, so a column added later is not exported until someone chooses it.
const COLS = {
  sessions: 'id, actor_kind, actor_id, last_seen_at, expires_at, revoked_at, created_at',
  links: 'id, entitlement_id, buyer_id, expires_at, uses, created_at',
  api_idempotency: 'id, key, actor_kind, actor_id, route, created_at',
  refund_requests:
    'id, unit_id, capture_id, amount_minor, currency, reason, requested_by, state, refund_id, created_at',
  provider_orders:
    'id, order_id, provider_order_id, route, status, state, position, po_ref, publisher_id, first_approved_at, created_at',
  // ID-ACCOUNTS: the account is the buyer's own (username, counts, times); the password hash is never exported.
  buyer_accounts:
    'buyer_id, username, failed_attempts, locked_until, password_changed_at, created_at, updated_at',
  operations:
    'id, order_id, unit_id, provider_order_ref, kind, state, attempt, failure_reason, created_at',
};

const OWNED_ORDERS = '(SELECT id FROM orders WHERE buyer_id = $1)';
const OWNED_UNITS = `(SELECT id FROM order_units WHERE order_id IN ${OWNED_ORDERS})`;
const OWNED_ENTITLEMENTS = '(SELECT id FROM entitlements WHERE buyer_id = $1)';
const OWNED_CASES = '(SELECT id FROM recovery_cases WHERE buyer_id = $1)';

// Every query filters by the buyer id, directly or through the buyer's own orders, entitlements or cases.
const EXPORT_TABLES = [
  ['buyers', 'id = $1'],
  ['buyer_accounts', 'buyer_id = $1'],
  ['consents', 'buyer_id = $1'],
  ['identity_links', 'buyer_id = $1'],
  ['sessions', "actor_kind = 'buyer' AND actor_id = $1"],
  ['briefs', 'buyer_id = $1'],
  ['proposals', 'buyer_id = $1'],
  ['quotes', 'buyer_id = $1'],
  ['approvals', 'buyer_id = $1'],
  ['orders', 'buyer_id = $1'],
  ['order_units', `order_id IN ${OWNED_ORDERS}`],
  ['provider_orders', `order_id IN ${OWNED_ORDERS}`],
  ['operations', `order_id IN ${OWNED_ORDERS}`],
  ['refund_requests', `unit_id IN ${OWNED_UNITS}`],
  ['entitlements', 'buyer_id = $1'],
  ['links', 'buyer_id = $1'],
  ['access_windows', `entitlement_id IN ${OWNED_ENTITLEMENTS}`],
  ['access_events', `entitlement_id IN ${OWNED_ENTITLEMENTS}`],
  ['receipts', `order_id IN ${OWNED_ORDERS}`],
  ['recovery_cases', 'buyer_id = $1'],
  ['recovery_actions', `case_id IN ${OWNED_CASES}`],
  ['api_idempotency', "actor_kind = 'buyer' AND actor_id = $1"],
  ['audit_log', '(actor_id = $1 OR target = $1)'],
];

const buyerExists = async (q, id) =>
  (await q.query('SELECT 1 AS one FROM buyers WHERE id = $1', [id])).rows.length === 1;

/**
 * Export (PRIV-3). Input: db, now (a Date), tty ({ isTTY, env }), buyer_id.
 * Output: { ok: true, value: { buyer_id, exported_at, tables } } or { ok: false, error }.
 */
export async function runExport(d) {
  const refused = refusal(d.tty);
  if (refused !== null) return err(refused);
  if (typeof d.buyer_id !== 'string' || !(await buyerExists(d.db, d.buyer_id)))
    return err('unknown buyer');
  const tables = {};
  for (const [name, where] of EXPORT_TABLES) {
    const r = await d.db.query(
      `SELECT ${COLS[name] ?? 't.*'} FROM ${name} t WHERE ${where} ORDER BY t::text`,
      [d.buyer_id],
    );
    const drop = OMIT[name] ?? [];
    tables[name] = r.rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k))),
    );
  }
  return ok({ buyer_id: d.buyer_id, exported_at: d.now.toISOString(), tables });
}

/**
 * Delete (PRIV-4). Input: db, clock, audit sink, tty, ask(prompt), write(line), buyer_id, operator_id, reason.
 * One transaction: buyer name and auth subject to the pseudonym, brief text removed, open sessions revoked,
 * one audit row with counts. Nothing to change means no write and no audit row. A failed audit write
 * rolls everything back.
 */
export async function runDelete(d) {
  const refused = refusal(d.tty);
  if (refused !== null) return err(refused);
  if (typeof d.operator_id !== 'string' || d.operator_id.trim() === '')
    return err('operator required');
  if (typeof d.reason !== 'string' || d.reason.trim() === '') return err('reason required');
  if (typeof d.buyer_id !== 'string' || !(await buyerExists(d.db, d.buyer_id)))
    return err('unknown buyer');
  const pseudonym = pseudonymFor(d.buyer_id);
  d.write(`Removing personal data of buyer ${d.buyer_id} (pseudonym ${pseudonym}).`);
  d.write('Ledger, receipts, approvals, access events and the audit log are kept as they are.');
  const typed = await d.ask(`Type the buyer id (${d.buyer_id}) to confirm: `);
  if (typed.trim() !== d.buyer_id) return err('confirmation not matched');
  const at = d.clock.now().toISOString();
  const counts = await d.db.transaction(async (tx) => {
    const buyers = await tx.query(
      `UPDATE buyers SET display_name = $2, auth_subject = $3, updated_at = $4
        WHERE id = $1 AND (display_name <> $2 OR auth_subject <> $3) RETURNING id`,
      [d.buyer_id, pseudonym, `deleted:${pseudonym}`, at],
    );
    const briefs = await tx.query(
      `UPDATE briefs SET raw_text = $2, structured = '{}'::jsonb, updated_at = $3
        WHERE buyer_id = $1 AND (raw_text <> $2 OR structured <> '{}'::jsonb) RETURNING id`,
      [d.buyer_id, REMOVED_TEXT, at],
    );
    const sessions = await tx.query(
      `UPDATE sessions SET revoked_at = $2, updated_at = $2
        WHERE actor_kind = 'buyer' AND actor_id = $1 AND revoked_at IS NULL RETURNING id`,
      [d.buyer_id, at],
    );
    // ID-ACCOUNTS: the account (username and password hash) is deleted, so sign in ends and the username is free.
    const accounts = await tx.query(
      'DELETE FROM buyer_accounts WHERE buyer_id = $1 RETURNING buyer_id',
      [d.buyer_id],
    );
    const c = {
      buyers: buyers.rows.length,
      briefs: briefs.rows.length,
      sessions_revoked: sessions.rows.length,
      accounts_deleted: accounts.rows.length,
    };
    if (c.buyers + c.briefs + c.sessions_revoked + c.accounts_deleted > 0)
      await d.audit.record(tx, {
        actor: { kind: 'operator', operator_id: d.operator_id, mfa: true },
        action: 'privacy.delete',
        target: d.buyer_id,
        reason: d.reason.trim(),
        detail: c,
      });
    return c;
  });
  const changed = counts.buyers + counts.briefs + counts.sessions_revoked > 0;
  d.write(
    changed
      ? `Done: ${counts.buyers} buyer row, ${counts.briefs} briefs, ${counts.sessions_revoked} sessions revoked.`
      : 'Nothing to change: this buyer was already removed.',
  );
  return ok({ changed, pseudonym, counts });
}
