// CO-10: restore round trip, offline. A seeded database is backed up, then restored from the
// tarball and from the logical export into fresh directories. Row counts and ledger sums match, the
// append-only triggers and the unique indexes hold after restore, a changed byte in either file
// refuses, a non-empty target refuses, and the restore stays far inside the 30 s test budget.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../packages/db/src/index';
import { rowCounts } from '../packages/db/src/export-sql';
import { systemClock } from '../packages/runtime/src/index';
import { runBackup } from './backup.mjs';
import { runRestore } from './restore.mjs';

const ROOT = join(__dirname, '..');
const T = '2026-10-21T10:00:00Z';
const HASH = 'a'.repeat(64);
const clock = { now: () => new Date(T) };
const wall = systemClock(); // real time, only to measure how long a restore takes
const made: string[] = [];
const fresh = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `co10r-${p}-`));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const j = (v: unknown) => JSON.stringify(v);
type Q = {
  query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (s: string) => Promise<void>;
};
async function ins(db: Q, table: string, row: Record<string, unknown>) {
  const r: Record<string, unknown> = { created_at: T, updated_at: T, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

let backupDir: string;
let counts: Record<string, number>;
let sums: unknown[];
const ledgerSums = async (db: Q) =>
  (
    await db.query(
      'SELECT kind, sum(amount_minor)::text AS total FROM ledger_entries GROUP BY kind ORDER BY kind',
    )
  ).rows;

beforeAll(async () => {
  const src = fresh('src');
  const db = await openDatabase({ kind: 'pglite-disk', dir: src });
  await migrate(db, clock);
  await ins(db, 'publishers', {
    id: 'pub_1',
    slug: 'p1',
    display_name: 'Pub One',
    country: 'US',
    paypal_merchant_id: 'MERCH1',
    payee_verified_at: T,
  });
  await ins(db, 'articles', {
    id: 'art_1',
    publisher_id: 'pub_1',
    title: 't',
    abstract: 'a',
    language: 'en',
    topics: ['x'],
    published_at: T,
    sha256: HASH,
    content_key: 'k1',
    bytes: 10,
    mime: 'text/plain',
  });
  await ins(db, 'buyers', { id: 'buy_1', display_name: 'B', auth_subject: 'sub1', country: 'US' });
  await ins(db, 'approvals', {
    id: 'apr_1',
    buyer_id: 'buy_1',
    snapshot: j({ v: 1 }),
    content_hash: HASH,
    nonce: 'nonce1',
    expires_at: '2026-10-21T10:15:00Z',
    used_at: null,
    environment: 'dryrun',
  });
  await ins(db, 'orders', {
    id: 'ord_1',
    approval_id: 'apr_1',
    buyer_id: 'buy_1',
    content_hash: HASH,
    order_ref: 'ref_1',
    expected: j({}),
    status: 'created',
    mismatch: false,
    corridor_id: 'us-usd',
    currency: 'USD',
    total_minor: 500,
    environment: 'dryrun',
  });
  await ins(db, 'order_units', {
    id: 'unt_1',
    order_id: 'ord_1',
    provider_order_ref: null,
    publisher_id: 'pub_1',
    reference_id: 'refid_1',
    payee_merchant_id: 'MERCH1',
    amount_minor: 500,
    platform_fee_minor: 0,
    capture_id: 'CAP1',
    status: 'partially_refunded',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 200,
    captured_verified_at: T,
    mismatch_reason: null,
  });
  await ins(db, 'entitlements', {
    id: 'ent_1',
    buyer_id: 'buy_1',
    article_id: 'art_1',
    unit_id: 'unt_1',
    option: 'keep_retrieve',
    policy: j({}),
    money_state: 'captured',
    access_state: 'locked',
    licence_state: 'granted',
    transition_log: j([]),
    environment: 'dryrun',
  });
  const led = (id: string, over: Record<string, unknown>) =>
    ins(db, 'ledger_entries', {
      id,
      unit_id: 'unt_1',
      capture_id: 'CAP1',
      currency: 'USD',
      refund_id: null,
      ref_entry_id: null,
      environment: 'dryrun',
      ...over,
    });
  await led('led_1', { kind: 'sale', amount_minor: 500 });
  await led('led_2', {
    kind: 'refund',
    amount_minor: 200,
    refund_id: 'RF1',
    ref_entry_id: 'led_1',
  });
  await ins(db, 'receipts', {
    id: 'rct_1',
    order_id: 'ord_1',
    version: 1,
    body: j({ total_minor: 500 }),
    sha256: HASH,
    environment: 'dryrun',
  });
  await ins(db, 'access_events', {
    id: 'aev_1',
    entitlement_id: 'ent_1',
    kind: 'access_ready',
    at: T,
    source: 'system',
    evidence: j({}),
    environment: 'dryrun',
  });
  counts = await rowCounts(db);
  sums = await ledgerSums(db);
  await db.close();
  backupDir = fresh('bk');
  rmSync(backupDir, { recursive: true });
  await runBackup({ dir: src, out: backupDir, clock });
}, 180_000);

// Copy the backup so a test can damage it without touching the others.
function copyBackup(): string {
  const to = fresh('bkcopy');
  for (const f of readdirSync(backupDir))
    writeFileSync(join(to, f), readFileSync(join(backupDir, f)));
  return to;
}
const target = () => join(fresh('t'), 'data');

async function verifyRestored(dir: string) {
  const db = await openDatabase({ kind: 'pglite-disk', dir });
  try {
    expect(await rowCounts(db)).toEqual(counts);
    expect(await ledgerSums(db)).toEqual(sums);
    // Ledger append-only invariants.
    await expect(
      db.query("UPDATE ledger_entries SET amount_minor = 1 WHERE id = 'led_1'"),
    ).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM ledger_entries WHERE id = 'led_2'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("DELETE FROM receipts WHERE id = 'rct_1'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.exec('TRUNCATE ledger_entries')).rejects.toThrow();
    await expect(
      ins(db, 'ledger_entries', {
        id: 'led_9',
        unit_id: 'unt_1',
        capture_id: 'CAP1',
        kind: 'refund',
        amount_minor: 400,
        currency: 'USD',
        refund_id: 'RF9',
        ref_entry_id: null,
        environment: 'dryrun',
      }),
    ).rejects.toThrow(/exceed/);
    await expect(
      ins(db, 'ledger_entries', {
        id: 'led_8',
        unit_id: 'unt_1',
        capture_id: 'CAP1',
        kind: 'sale',
        amount_minor: 500,
        currency: 'USD',
        refund_id: null,
        ref_entry_id: null,
        environment: 'dryrun',
      }),
    ).rejects.toThrow();
    const off = await db.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'",
    );
    expect(off.rows).toEqual([]);
    // Unique active entitlement: a second active entitlement for the same buyer and article is refused.
    await ins(db, 'order_units', {
      id: 'unt_2',
      order_id: 'ord_1',
      provider_order_ref: null,
      publisher_id: 'pub_1',
      reference_id: 'refid_2',
      payee_merchant_id: 'MERCH1',
      amount_minor: 100,
      platform_fee_minor: 0,
      capture_id: null,
      status: 'expected',
      status_reason: null,
      paypal_fee_minor: null,
      refunded_minor: 0,
      captured_verified_at: null,
      mismatch_reason: null,
    });
    await expect(
      ins(db, 'entitlements', {
        id: 'ent_2',
        buyer_id: 'buy_1',
        article_id: 'art_1',
        unit_id: 'unt_2',
        option: 'keep_retrieve',
        policy: j({}),
        money_state: 'pending',
        access_state: 'locked',
        licence_state: null,
        transition_log: j([]),
        environment: 'dryrun',
      }),
    ).rejects.toThrow(/entitlements_one_active_per_buyer_article|unique/i);
    // The identity column carries on after the highest restored value.
    await ins(db, 'access_events', {
      id: 'aev_2',
      entitlement_id: 'ent_1',
      kind: 'reader_rendered',
      at: T,
      source: 'buyer',
      evidence: j({}),
      environment: 'dryrun',
    });
    const seqs = (await db.query('SELECT seq::int AS s FROM access_events ORDER BY seq')).rows as {
      s: number;
    }[];
    expect(seqs[1]!.s).toBeGreaterThan(seqs[0]!.s);
  } finally {
    await db.close();
  }
}

describe('tarball restore', () => {
  it('gives identical row counts and ledger sums, with the guards intact, inside the budget', async () => {
    const dir = target();
    const t0 = wall.now().getTime();
    const res = await runRestore({ from: backupDir, dir, clock });
    const seconds = (wall.now().getTime() - t0) / 1000;
    expect(res.mode).toBe('tarball');
    expect(res.tables).toEqual(counts);
    expect(seconds).toBeLessThan(30);
    await verifyRestored(dir);
  }, 180_000);
});

describe('SQL restore', () => {
  it('imports the logical export into a fresh database with identical counts and ledger sums', async () => {
    const dir = target();
    const t0 = wall.now().getTime();
    const res = await runRestore({ from: backupDir, dir, sql: true, clock });
    const seconds = (wall.now().getTime() - t0) / 1000;
    expect(res.mode).toBe('sql');
    expect(res.tables).toEqual(counts);
    expect(seconds).toBeLessThan(30);
    await verifyRestored(dir);
  }, 180_000);
});

describe('what the restore refuses', () => {
  const tarName = (d: string) => readdirSync(d).find((f) => f.endsWith('.tar.gz'))!;
  const sqlName = (d: string) => readdirSync(d).find((f) => f.endsWith('.sql'))!;

  for (const mode of [false, true]) {
    const label = mode ? '--sql' : 'tarball';
    it(`a changed byte in the tarball refuses (${label}) and leaves the target empty`, async () => {
      const from = copyBackup();
      const p = join(from, tarName(from));
      const buf = readFileSync(p);
      buf[Math.floor(buf.length / 2)] = buf[Math.floor(buf.length / 2)]! ^ 0x01;
      writeFileSync(p, buf);
      const dir = target();
      await expect(runRestore({ from, dir, sql: mode, clock })).rejects.toThrow(
        /hash|sha256|changed/i,
      );
      expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true);
    }, 120_000);

    it(`a changed byte in the SQL export refuses (${label}) and leaves the target empty`, async () => {
      const from = copyBackup();
      const p = join(from, sqlName(from));
      appendFileSync(p, ' ');
      const dir = target();
      await expect(runRestore({ from, dir, sql: mode, clock })).rejects.toThrow(
        /hash|sha256|changed/i,
      );
      expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true);
    }, 120_000);

    it(`a non-empty target refuses (${label}) and keeps what was there`, async () => {
      const dir = target();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'keep.txt'), 'keep');
      await expect(runRestore({ from: backupDir, dir, sql: mode, clock })).rejects.toThrow(
        /not empty/i,
      );
      expect(readdirSync(dir)).toEqual(['keep.txt']);
      expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep');
    });
  }

  it('a changed row count in the manifest refuses', async () => {
    const from = copyBackup();
    const m = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
    m.tables.ledger_entries += 1;
    writeFileSync(join(from, 'manifest.json'), JSON.stringify(m));
    for (const sql of [false, true]) {
      const dir = target();
      await expect(runRestore({ from, dir, sql, clock })).rejects.toThrow(/row count|count/i);
      expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true);
    }
  }, 180_000);

  it('a manifest naming a file outside the folder refuses', async () => {
    const from = copyBackup();
    const m = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
    m.files.tarball.name = '../../etc/passwd';
    writeFileSync(join(from, 'manifest.json'), JSON.stringify(m));
    await expect(runRestore({ from, dir: target(), clock })).rejects.toThrow(/manifest/i);
  });

  it('a missing manifest or a missing file refuses', async () => {
    const empty = fresh('nomanifest');
    await expect(runRestore({ from: empty, dir: target(), clock })).rejects.toThrow(/manifest/i);
    const from = copyBackup();
    rmSync(join(from, sqlName(from)));
    await expect(runRestore({ from, dir: target(), clock })).rejects.toThrow();
  });
});

describe('the command line', () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ['scripts/restore.mjs', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {},
    });

  it('restores end to end with exit 0, refuses a non-empty target with exit 1, exits 2 on bad arguments', () => {
    const dir = target();
    const ok = cli(['--from', backupDir, '--dir', dir]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/restore ok/);
    const again = cli(['--from', backupDir, '--dir', dir]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/not empty/i);
    const bad = cli(['--from', backupDir]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/usage: .*restore\.mjs --from <folder> --dir <empty dir>/);
    expect(bad.stderr).not.toMatch(/\n\s+at /);
  }, 180_000);

  it('--sql restores from the logical export', () => {
    const dir = target();
    const r = cli(['--from', backupDir, '--dir', dir, '--sql']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/restore ok.*sql/i);
  }, 180_000);

  it('the script reads no environment variable and opens no connection (source check)', () => {
    const src = readFileSync(join(__dirname, 'restore.mjs'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\bfetch\s*\(|node:(net|tls|http|https|dns|dgram)/);
  });
});
