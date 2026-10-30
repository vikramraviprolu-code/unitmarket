// OPS-PRIV (PRIV-3, PRIV-4), docs/specs/ops-privacy-export-delete.md: the operator privacy script.
// State test on an in-memory database with two buyers who each have a full set of rows. Export of
// buyer A holds A's rows and nothing of B or of a publisher; delete of A pseudonymises the personal
// fields, leaves the money evidence byte for byte as it was, writes one audit row, and a second
// delete changes nothing.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../domain/payments/src/index';
import { migrate, openDatabase } from '../packages/db/src/index';
import { createAuditSink } from '../packages/obs/src/index';
import { fakeClock, seededIds } from '../packages/runtime/src/index';
import { pseudonymFor, runDelete, runExport } from './lib/privacy.mjs';

const T = '2026-10-30T10:00:00Z';
const LATER = '2026-10-30T12:00:00Z';
const HASH = 'a'.repeat(64);
const TTY = { isTTY: true, env: {} as Record<string, string | undefined> };

// Personal values, written so that each can be searched for as plain text.
const A_NAME = 'Alice Wonderland';
const A_SUBJECT = 'sub-alice-9137';
const A_BRIEF = 'Alice needs quiet pond ecology papers for her thesis';
const B_NAME = 'Bernard Bystander';
const B_SUBJECT = 'sub-bernard-4421';
const B_BRIEF = 'Bernard wants tax summaries for his shop';
const PUB1 = 'Pondside Press';
const PUB2 = 'Ledger Letters';
const MERCH1 = 'MERCHPOND1';
const MERCH2 = 'MERCHLEDGE2';

const POLICY = {
  id: 'keep_retrieve',
  version: '1',
  option: 'keep_retrieve',
  window_ms: 432_000_000,
  start_rule: 'payment_verified_and_delivery_ready',
};

type Db = Awaited<ReturnType<typeof openDatabase>>;
const j = (v: unknown) => JSON.stringify(v);

async function ins(db: Db, table: string, row: Record<string, unknown>) {
  const r: Record<string, unknown> = { created_at: T, updated_at: T, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// One buyer with the whole set of buyer-owned rows. k is a short key: a or b.
async function seedBuyer(
  db: Db,
  k: string,
  o: {
    name: string;
    subject: string;
    brief: string;
    pub: string;
    article: string;
    merchant: string;
  },
) {
  const B = `buy_${k}`;
  await ins(db, 'buyers', { id: B, display_name: o.name, auth_subject: o.subject, country: 'US' });
  await ins(db, 'consents', {
    id: `con_${k}`,
    buyer_id: B,
    kind: 'terms',
    text_version: 'v1',
    granted_at: T,
    revoked_at: null,
  });
  await ins(db, 'identity_links', {
    id: `idl_${k}`,
    buyer_id: B,
    provider: 'paypal',
    subject_hash: sha(`link-${k}`),
    consent_id: `con_${k}`,
    revoked_at: null,
  });
  await ins(db, 'sessions', {
    id: `ses_${k}`,
    actor_kind: 'buyer',
    actor_id: B,
    csrf_token_hash: sha(`csrf-${k}`),
    last_seen_at: T,
    expires_at: '2026-10-31T10:00:00Z',
    revoked_at: null,
  });
  await ins(db, 'briefs', {
    id: `bri_${k}`,
    buyer_id: B,
    raw_text: o.brief,
    structured: j({ topics: [o.brief] }),
    version: '1',
    confirmed_at: T,
  });
  await ins(db, 'proposals', {
    id: `prp_${k}`,
    brief_id: `bri_${k}`,
    buyer_id: B,
    items: j([{ article_id: o.article }]),
    fit: j({ score: 3 }),
  });
  await ins(db, 'offers', {
    id: `ofr_${k}`,
    version: '1',
    publisher_id: o.pub,
    article_id: o.article,
    status: 'authorised',
    currency: 'USD',
    options: j({}),
    affordability: j({}),
    terms_version: 'v1',
    rights: j({}),
    valid_from: T,
    valid_until: null,
    superseded_by: null,
  });
  await ins(db, 'quotes', {
    id: `quo_${k}`,
    buyer_id: B,
    offer_id: `ofr_${k}`,
    offer_version: '1',
    option: 'keep_retrieve',
    price_minor: 500,
    currency: 'USD',
    corridor_id: 'us-usd',
    source: 'direct',
    expires_at: '2026-10-30T11:00:00Z',
  });
  await ins(db, 'approvals', {
    id: `apr_${k}`,
    buyer_id: B,
    snapshot: j({ v: 1, buyer: B }),
    content_hash: HASH,
    nonce: `nonce-${k}-secret`,
    expires_at: '2026-10-30T10:15:00Z',
    used_at: null,
    environment: 'dryrun',
  });
  await ins(db, 'orders', {
    id: `ord_${k}`,
    approval_id: `apr_${k}`,
    buyer_id: B,
    content_hash: HASH,
    order_ref: `ref_${k}`,
    expected: j({}),
    status: 'paid',
    mismatch: false,
    corridor_id: 'us-usd',
    currency: 'USD',
    total_minor: 500,
    environment: 'dryrun',
  });
  await ins(db, 'order_units', {
    id: `unt_${k}`,
    order_id: `ord_${k}`,
    provider_order_ref: null,
    publisher_id: o.pub,
    reference_id: `refid_${k}`,
    payee_merchant_id: o.merchant,
    amount_minor: 500,
    platform_fee_minor: 0,
    capture_id: `CAP${k.toUpperCase()}`,
    status: 'captured_verified',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 0,
    captured_verified_at: T,
    mismatch_reason: null,
  });
  await ins(db, 'ledger_entries', {
    id: `led_${k}`,
    unit_id: `unt_${k}`,
    capture_id: `CAP${k.toUpperCase()}`,
    kind: 'sale',
    amount_minor: 500,
    currency: 'USD',
    refund_id: null,
    ref_entry_id: null,
    environment: 'dryrun',
  });
  await ins(db, 'entitlements', {
    id: `ent_${k}`,
    buyer_id: B,
    article_id: o.article,
    unit_id: `unt_${k}`,
    option: 'keep_retrieve',
    policy: j(POLICY),
    money_state: 'captured',
    access_state: 'locked',
    licence_state: 'granted',
    transition_log: j([]),
    environment: 'dryrun',
  });
  await ins(db, 'access_windows', {
    entitlement_id: `ent_${k}`,
    state: 'not_started',
    started_at: null,
    base_ends_at: null,
    ends_at: null,
    paused_at: null,
    credit_ms: 0,
  });
  await ins(db, 'links', {
    id: `lnk_${k}`,
    entitlement_id: `ent_${k}`,
    buyer_id: B,
    token_hash: sha(`token-${k}`),
    expires_at: '2026-10-31T10:00:00Z',
    uses: 0,
  });
  await ins(db, 'access_events', {
    id: `aev_${k}`,
    entitlement_id: `ent_${k}`,
    link_id: null,
    kind: 'link_issued',
    at: T,
    source: 'system',
    evidence: j({ note: 'issued' }),
    environment: 'dryrun',
  });
  // The receipt body names the publisher (as a real one does) and never the buyer.
  // Keys in the order jsonb hands them back (shorter first), so the stored text hashes the same after a read.
  const body = j({ lines: [{ minor: 500, publisher_display_name: o.pub }], order_id: `ord_${k}` });
  await ins(db, 'receipts', {
    id: `rct_${k}`,
    order_id: `ord_${k}`,
    version: 1,
    body,
    sha256: sha(body),
    environment: 'dryrun',
  });
  await ins(db, 'recovery_cases', {
    id: `cas_${k}`,
    kind: 'delivery_failed',
    state: 'open',
    order_id: `ord_${k}`,
    entitlement_id: `ent_${k}`,
    buyer_id: B,
    opened_by: 'buyer',
    sla_due_at: '2026-10-31T10:00:00Z',
    credit_ms: 0,
    buyer_message: `We are looking into case ${k}.`,
  });
  await ins(db, 'recovery_actions', {
    id: `rca_${k}`,
    case_id: `cas_${k}`,
    action: 'opened',
    actor: 'system',
    detail: j({ note: `case ${k}` }),
    at: T,
  });
}

async function seed() {
  const db = await openDatabase({ kind: 'pglite-memory' });
  await migrate(db, fakeClock(T));
  for (const [id, slug, name, merchant, article] of [
    ['pub_1', 'p1', PUB1, MERCH1, 'art_1'],
    ['pub_2', 'p2', PUB2, MERCH2, 'art_2'],
  ] as const) {
    await ins(db, 'publishers', {
      id,
      slug,
      display_name: name,
      country: 'US',
      paypal_merchant_id: merchant,
      payee_verified_at: T,
    });
    await ins(db, 'articles', {
      id: article,
      publisher_id: id,
      title: `Title ${article}`,
      abstract: 'abstract',
      language: 'en',
      topics: ['x'],
      published_at: T,
      sha256: HASH,
      content_key: `key-${article}`,
      bytes: 10,
      mime: 'text/plain',
    });
  }
  await seedBuyer(db, 'a', {
    name: A_NAME,
    subject: A_SUBJECT,
    brief: A_BRIEF,
    pub: 'pub_1',
    article: 'art_1',
    merchant: MERCH1,
  });
  await seedBuyer(db, 'b', {
    name: B_NAME,
    subject: B_SUBJECT,
    brief: B_BRIEF,
    pub: 'pub_2',
    article: 'art_2',
    merchant: MERCH2,
  });
  return db;
}

// Every table, every row, as text: the byte for byte comparison of the whole database.
async function dump(db: Db): Promise<Record<string, string>> {
  const t = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const out: Record<string, string> = {};
  for (const { table_name } of t.rows) {
    const r = await db.query(`SELECT t::text AS row FROM ${table_name} t ORDER BY 1`);
    out[table_name] = j(r.rows);
  }
  return out;
}
const changedTables = (a: Record<string, string>, b: Record<string, string>): string[] =>
  Object.keys(a)
    .filter((k) => a[k] !== b[k])
    .sort();

// Each call gets its own id seed, so two audit sinks in one test never mint the same id.
let sinkCount = 0;
function opts(db: Db, over: Record<string, unknown> = {}) {
  const clock = fakeClock(LATER);
  const out: string[] = [];
  return {
    out,
    args: {
      db,
      clock,
      audit: createAuditSink(seededIds(`privacy-test-${String((sinkCount += 1))}`), clock),
      tty: TTY,
      ask: async () => 'buy_a',
      write: (line: string) => void out.push(line),
      buyer_id: 'buy_a',
      operator_id: 'opr_1',
      reason: 'buyer request 2026-10-29',
      ...over,
    },
  };
}

const failingInvariants = async (db: Db) =>
  (await checkInvariants(db)).filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`);

describe('export', () => {
  it("holds the buyer's rows and nothing of another buyer or a publisher; writes nothing", async () => {
    const db = await seed();
    const before = await dump(db);
    const r = await runExport({ db, now: new Date(LATER), tty: TTY, buyer_id: 'buy_a' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const doc = r.value;
    expect(doc.buyer_id).toBe('buy_a');
    expect(doc.exported_at).toBe(new Date(LATER).toISOString());
    const t = doc.tables as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(t).sort()).toEqual(
      [
        'access_events',
        'access_windows',
        'approvals',
        'briefs',
        'buyers',
        'consents',
        'entitlements',
        'identity_links',
        'order_units',
        'orders',
        'proposals',
        'quotes',
        'receipts',
        'recovery_actions',
        'recovery_cases',
      ].sort(),
    );
    // A's rows, one of each.
    for (const [name, rows] of Object.entries(t)) expect(rows, name).toHaveLength(1);
    expect(t['buyers']![0]).toMatchObject({
      id: 'buy_a',
      display_name: A_NAME,
      auth_subject: A_SUBJECT,
    });
    expect(t['briefs']![0]).toMatchObject({ raw_text: A_BRIEF });
    expect(t['orders']![0]).toMatchObject({ id: 'ord_a' });
    expect(t['receipts']![0]).toMatchObject({ id: 'rct_a', order_id: 'ord_a' });
    expect(t['entitlements']![0]).toMatchObject({ id: 'ent_a' });
    expect(t['access_events']![0]).toMatchObject({ id: 'aev_a' });
    expect(t['recovery_cases']![0]).toMatchObject({ id: 'cas_a' });
    // Nothing of B or of a publisher, by value and by id.
    const text = j(doc);
    for (const v of [
      'buy_b',
      B_NAME,
      B_SUBJECT,
      B_BRIEF,
      'ord_b',
      'rct_b',
      'ent_b',
      'cas_b',
      'unt_b',
      'art_2',
      PUB2,
      MERCH2,
      MERCH1,
      'pub_2',
    ])
      expect(text, v).not.toContain(v);
    // A secret-like value stays out: the approval nonce and the identity link hash source.
    expect(text).not.toContain('nonce-a-secret');
    expect(t['approvals']![0]).not.toHaveProperty('nonce');
    expect(t['order_units']![0]).not.toHaveProperty('payee_merchant_id');
    // It read only: no row of any table changed.
    expect(changedTables(before, await dump(db))).toEqual([]);
    await db.close();
  }, 60_000);

  it('refuses an unknown buyer and a malformed id, and reveals nothing about other buyers', async () => {
    const db = await seed();
    for (const id of ['buy_nobody', '', ' buy_a']) {
      const r = await runExport({ db, now: new Date(LATER), tty: TTY, buyer_id: id });
      expect(r).toMatchObject({ ok: false });
    }
    const r = await runExport({ db, now: new Date(LATER), tty: TTY, buyer_id: 'buy_nobody' });
    expect(r).toEqual({ ok: false, error: 'unknown buyer' });
    await db.close();
  }, 60_000);
});

describe('delete', () => {
  it('pseudonymises the personal fields and leaves the money evidence byte for byte as it was', async () => {
    const db = await seed();
    expect(await failingInvariants(db)).toEqual([]);
    const before = await dump(db);
    const { args, out } = opts(db);
    const r = await runDelete(args);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const pseudo = `deleted-${createHash('sha256').update('buy_a').digest('hex').slice(0, 8)}`;
    expect(pseudonymFor('buy_a')).toBe(pseudo);
    expect(r.value).toMatchObject({ changed: true, pseudonym: pseudo });

    const after = await dump(db);
    // Only these four tables change: the buyer, the briefs, the sessions, and the audit log.
    expect(changedTables(before, after)).toEqual(['audit_log', 'briefs', 'buyers', 'sessions']);
    // Every append-only and money table is byte equal.
    for (const tbl of [
      'ledger_entries',
      'receipts',
      'approvals',
      'access_events',
      'provider_calls',
      'orders',
      'order_units',
      'entitlements',
      'access_windows',
      'recovery_cases',
      'recovery_actions',
      'quotes',
      'proposals',
      'consents',
      'identity_links',
    ])
      expect(after[tbl], tbl).toBe(before[tbl]);

    const buyer = await db.query(
      `SELECT display_name, auth_subject FROM buyers WHERE id = 'buy_a'`,
    );
    expect(buyer.rows).toEqual([{ display_name: pseudo, auth_subject: `deleted:${pseudo}` }]);
    const brief = await db.query(
      `SELECT raw_text, structured FROM briefs WHERE buyer_id = 'buy_a'`,
    );
    expect(brief.rows).toEqual([{ raw_text: '[removed]', structured: {} }]);
    const ses = await db.query(`SELECT revoked_at FROM sessions WHERE actor_id = 'buy_a'`);
    expect(ses.rows).toHaveLength(1);
    expect((ses.rows[0] as { revoked_at: unknown }).revoked_at).not.toBeNull();

    // B is untouched, row for row.
    for (const tbl of ['buyers', 'briefs', 'sessions']) {
      const rowsB = async (d: Record<string, string>) =>
        (JSON.parse(d[tbl]!) as { row: string }[]).filter((x) => x.row.includes('buy_b'));
      expect(await rowsB(after), tbl).toEqual(await rowsB(before));
    }

    // The text of A's name, subject and brief is in no row of any table the script changed.
    for (const tbl of ['buyers', 'briefs', 'sessions', 'audit_log'])
      for (const v of [A_NAME, A_SUBJECT, A_BRIEF, 'pond ecology'])
        expect(after[tbl], `${tbl} / ${v}`).not.toContain(v);
    // The receipt body holds no personal value of A, and its hash still matches its stored body.
    const rc = await db.query<{ body: unknown; sha256: string }>(
      `SELECT body, sha256 FROM receipts WHERE order_id = 'ord_a'`,
    );
    const rcText = j(rc.rows[0]!.body);
    for (const v of [A_NAME, A_SUBJECT, A_BRIEF]) expect(rcText).not.toContain(v);
    expect(sha(rcText)).toBe(rc.rows[0]!.sha256);

    // Money invariants INV1 to INV7 all hold after the delete.
    const all = await checkInvariants(db);
    expect(all.map((x) => x.id)).toEqual(['INV1', 'INV2', 'INV3', 'INV4', 'INV5', 'INV6', 'INV7']);
    expect(await failingInvariants(db)).toEqual([]);

    // The operator saw which database object it touched, by id and counts, and no personal value.
    const shown = out.join('\n');
    expect(shown).toContain('buy_a');
    for (const v of [A_NAME, A_SUBJECT, A_BRIEF]) expect(shown).not.toContain(v);
    await db.close();
  }, 60_000);

  it('writes exactly one audit row: operator, privacy.delete, the buyer id, the reason, counts only', async () => {
    const db = await seed();
    const { args } = opts(db);
    await runDelete(args);
    const a = await db.query<Record<string, unknown>>(
      `SELECT actor_kind, actor_id, action, target, reason, detail FROM audit_log`,
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_1',
      action: 'privacy.delete',
      target: 'buy_a',
      reason: 'buyer request 2026-10-29',
    });
    const detail = a.rows[0]!['detail'] as Record<string, unknown>;
    expect(detail).toMatchObject({ buyers: 1, briefs: 1, sessions_revoked: 1 });
    // Counts only. The audit sink adds one flag for the operator's second factor; it is not a personal value.
    for (const [k, v] of Object.entries(detail))
      if (k !== 'actor_mfa') expect(typeof v, k).toBe('number');
    await db.close();
  }, 60_000);

  it('is idempotent: a second delete changes nothing, not even the audit log', async () => {
    const db = await seed();
    const { args } = opts(db);
    expect((await runDelete(args)).ok).toBe(true);
    const mid = await dump(db);
    const second = await runDelete(opts(db).args);
    expect(second).toMatchObject({ ok: true, value: { changed: false } });
    expect(changedTables(mid, await dump(db))).toEqual([]);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`);
    expect(n.rows[0]!.n).toBe(1);
    await db.close();
  }, 60_000);

  it('refuses an unknown buyer without writing anything', async () => {
    const db = await seed();
    const before = await dump(db);
    const r = await runDelete(
      opts(db, { buyer_id: 'buy_nobody', ask: async () => 'buy_nobody' }).args,
    );
    expect(r).toEqual({ ok: false, error: 'unknown buyer' });
    expect(changedTables(before, await dump(db))).toEqual([]);
    await db.close();
  }, 60_000);

  it('does nothing unless the operator types the buyer id back', async () => {
    const db = await seed();
    const before = await dump(db);
    for (const typed of ['', 'buy_b', 'yes', 'BUY_A']) {
      const r = await runDelete(opts(db, { ask: async () => typed }).args);
      expect(r).toEqual({ ok: false, error: 'confirmation not matched' });
    }
    expect(changedTables(before, await dump(db))).toEqual([]);
    await db.close();
  }, 60_000);

  it('needs an operator id and a reason', async () => {
    const db = await seed();
    const before = await dump(db);
    expect(await runDelete(opts(db, { reason: '  ' }).args)).toEqual({
      ok: false,
      error: 'reason required',
    });
    expect(await runDelete(opts(db, { operator_id: '' }).args)).toEqual({
      ok: false,
      error: 'operator required',
    });
    expect(changedTables(before, await dump(db))).toEqual([]);
    await db.close();
  }, 60_000);

  it('is one transaction: a failed audit write rolls the personal-data changes back', async () => {
    const db = await seed();
    const before = await dump(db);
    const failing = {
      record: async () => {
        throw new Error('audit down');
      },
    };
    await expect(runDelete(opts(db, { audit: failing }).args)).rejects.toThrow('audit down');
    expect(changedTables(before, await dump(db))).toEqual([]);
    await db.close();
  }, 60_000);

  it('finishes a half-done delete: a new session or brief after a delete is cleaned and audited', async () => {
    const db = await seed();
    expect((await runDelete(opts(db).args)).ok).toBe(true);
    await ins(db, 'sessions', {
      id: 'ses_a2',
      actor_kind: 'buyer',
      actor_id: 'buy_a',
      csrf_token_hash: sha('csrf-a2'),
      last_seen_at: T,
      expires_at: '2026-10-31T10:00:00Z',
      revoked_at: null,
    });
    const r = await runDelete(opts(db).args);
    expect(r).toMatchObject({ ok: true, value: { changed: true } });
    const open = await db.query(
      `SELECT id FROM sessions WHERE actor_id = 'buy_a' AND revoked_at IS NULL`,
    );
    expect(open.rows).toEqual([]);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`);
    expect(n.rows[0]!.n).toBe(2);
    await db.close();
  }, 60_000);
});

describe('guards', () => {
  it('both commands refuse without a terminal, in CI, and in an AI session, before touching the database', async () => {
    const db = await seed();
    const before = await dump(db);
    const cases: [Record<string, unknown>, string][] = [
      [{ isTTY: false, env: {} }, 'not a terminal'],
      [{ isTTY: undefined, env: {} }, 'not a terminal'],
      [{ isTTY: true, env: { CI: '1' } }, 'CI'],
      [{ isTTY: true, env: { GITHUB_ACTIONS: 'true' } }, 'CI'],
      [{ isTTY: false, env: { CI: 'true' } }, 'CI'],
      [{ isTTY: true, env: { CLAUDECODE: '1' } }, 'AI session'],
      [{ isTTY: true, env: { CLAUDE_CODE_REMOTE: 'true' } }, 'AI session'],
    ];
    for (const [tty, error] of cases) {
      expect(
        await runExport({ db, now: new Date(LATER), tty, buyer_id: 'buy_a' } as never),
      ).toEqual({
        ok: false,
        error,
      });
      expect(await runDelete(opts(db, { tty }).args as never)).toEqual({ ok: false, error });
    }
    expect(changedTables(before, await dump(db))).toEqual([]);
    await db.close();
  }, 60_000);
});
