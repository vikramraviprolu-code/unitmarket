// CO-10: offline backup of the PGlite data directory. A seeded on-disk database (an order, a
// capture, a refund and a receipt) is backed up; the manifest counts match the database, the files
// match their hashes, a running app refuses the backup, and nothing secret or personal is added.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../packages/db/src/index';
import { rowCounts } from '../packages/db/src/export-sql';
import { runBackup } from './backup.mjs';
import { scanText } from './log-scan.mjs';

const ROOT = join(__dirname, '..');
const T = '2026-10-21T10:00:00Z';
const HASH = 'a'.repeat(64);
const clock = { now: () => new Date(T) };
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `co10-${p}-`));
const made: string[] = [];
const fresh = (p: string) => {
  const d = tmp(p);
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const j = (v: unknown) => JSON.stringify(v);
async function ins(
  db: { query: (s: string, p?: unknown[]) => Promise<unknown> },
  table: string,
  row: Record<string, unknown>,
) {
  const r: Record<string, unknown> = { created_at: T, updated_at: T, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

// A planted secret and a planted address: neither may reach a backup file, the manifest or a log.
const PLANTED = ['FAKE', 'SECRET', 'VALUE', 'for', 'co10', 'scan'].join('-') + '-9f3k2m7q';

let srcDir: string;
let counts: Record<string, number>;
beforeAll(async () => {
  srcDir = fresh('src');
  const db = await openDatabase({ kind: 'pglite-disk', dir: srcDir });
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
  counts = await rowCounts(db);
  await db.close();
}, 120_000);

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['scripts/backup.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });

describe('backup of a seeded database', () => {
  it('writes the tarball, the logical export and a manifest whose counts and hashes match', async () => {
    const out = fresh('out');
    const res = await runBackup({ dir: srcDir, out, clock });
    const names = readdirSync(out).sort();
    expect(names).toEqual([
      'export-20261021T100000Z.sql',
      'manifest.json',
      'pglite-20261021T100000Z.tar.gz',
    ]);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(res.manifest).toEqual(manifest);
    expect(manifest.format).toBe(1);
    expect(manifest.created_at).toBe(T);
    expect(manifest.migration_version).toMatch(/^\d{4}_/);
    expect(manifest.tables).toEqual(counts);
    expect(manifest.tables.ledger_entries).toBe(2);
    expect(manifest.tables.receipts).toBe(1);
    expect(manifest.tables.order_units).toBe(1);
    expect(manifest.files.tarball).toMatchObject({
      name: 'pglite-20261021T100000Z.tar.gz',
      sha256: sha(join(out, 'pglite-20261021T100000Z.tar.gz')),
    });
    expect(manifest.files.sql).toMatchObject({
      name: 'export-20261021T100000Z.sql',
      sha256: sha(join(out, 'export-20261021T100000Z.sql')),
    });
    expect(manifest.files.tarball.bytes).toBe(
      statSync(join(out, manifest.files.tarball.name)).size,
    );
    // The export names the same migration version as the manifest and is in FK order.
    expect(readFileSync(join(out, manifest.files.sql.name), 'utf8')).toContain(
      `-- schema-version: ${manifest.migration_version}`,
    );
    // A manifest holds names, counts and hashes only: no row value from the seeded data.
    const text = readFileSync(join(out, 'manifest.json'), 'utf8');
    for (const v of ['Pub One', 'MERCH1', 'sub1', 'nonce1', 'CAP1']) expect(text).not.toContain(v);
    expect(Object.keys(manifest).sort()).toEqual([
      'created_at',
      'files',
      'format',
      'migration_version',
      'tables',
    ]);
  }, 120_000);

  it('leaves the source directory in place and its data unchanged', async () => {
    const out = fresh('out');
    await runBackup({ dir: srcDir, out, clock });
    expect(existsSync(join(srcDir, 'PG_VERSION'))).toBe(true);
    const db = await openDatabase({ kind: 'pglite-disk', dir: srcDir });
    expect(await rowCounts(db)).toEqual(counts);
    await db.close();
  }, 120_000);

  it('creates private files: the output folder 0700, the files 0600', async () => {
    const out = join(fresh('parent'), 'nested');
    await runBackup({ dir: srcDir, out, clock });
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(out)) expect(statSync(join(out, f)).mode & 0o777).toBe(0o600);
  }, 120_000);

  it('refuses to overwrite an earlier backup in the same folder', async () => {
    const out = fresh('out');
    await runBackup({ dir: srcDir, out, clock });
    const before = readFileSync(join(out, 'manifest.json'), 'utf8');
    await expect(runBackup({ dir: srcDir, out, clock })).rejects.toThrow(/already holds a backup/);
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe(before);
  }, 120_000);
});

describe('what the backup refuses', () => {
  it('refuses while the app holds the directory (live pid on this host): exit 1, nothing written', () => {
    const dir = fresh('locked');
    // A copy is not needed: the lock check runs before the directory is opened.
    writeFileSync(join(dir, 'PG_VERSION'), '17\n');
    writeFileSync(
      join(dir, '.ums-open.lock'),
      j({ pid: process.pid, host: hostname(), started: T }),
    );
    const out = join(fresh('o'), 'bk');
    const r = cli(['--dir', dir, '--out', out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/holds this database|in use|Stop it first/i);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a lock it cannot read, a lock held on another host, and a lock that is not a plain file', async () => {
    for (const make of [
      (lock: string) => writeFileSync(lock, 'not a lock'),
      (lock: string) =>
        writeFileSync(lock, j({ pid: 1, host: `${hostname()}-elsewhere`, started: T })),
      (lock: string) => mkdirSync(lock),
      (lock: string) => symlinkSync('/etc/hostname', lock),
    ]) {
      const dir = fresh('locked');
      writeFileSync(join(dir, 'PG_VERSION'), '17\n');
      make(join(dir, '.ums-open.lock'));
      const out = join(fresh('o'), 'bk');
      await expect(runBackup({ dir, out, clock })).rejects.toThrow(/lock/i);
      expect(existsSync(out)).toBe(false);
    }
  });

  it('goes ahead past a lock that names a dead pid on this host, with a printed warning', async () => {
    const dir = fresh('stale');
    const { cpSync } = await import('node:fs');
    cpSync(srcDir, dir, { recursive: true });
    writeFileSync(
      join(dir, '.ums-open.lock'),
      j({ pid: 2 ** 22 + 12345, host: hostname(), started: T }),
    );
    const out = join(fresh('o'), 'bk');
    const warnings: string[] = [];
    await runBackup({ dir, out, clock, warn: (m: string) => warnings.push(m) });
    expect(warnings.join('\n')).toMatch(/stale|dead|not running/i);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);
  }, 120_000);

  it('refuses a directory that is not a PGlite data directory, without creating one', async () => {
    const empty = fresh('empty');
    const out = join(fresh('o'), 'bk');
    await expect(runBackup({ dir: empty, out, clock })).rejects.toThrow(/PG_VERSION|not a PGlite/i);
    expect(readdirSync(empty)).toEqual([]);
    const missing = join(fresh('m'), 'nope');
    await expect(runBackup({ dir: missing, out, clock })).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses an output folder inside the repository', async () => {
    const out = join(ROOT, '.sbx-local', 'co10-should-not-exist');
    await expect(runBackup({ dir: srcDir, out, clock })).rejects.toThrow(/repository/i);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an output folder that is the data directory or sits inside it', async () => {
    await expect(runBackup({ dir: srcDir, out: srcDir, clock })).rejects.toThrow();
    await expect(runBackup({ dir: srcDir, out: join(srcDir, 'bk'), clock })).rejects.toThrow();
  });

  it('exits 2 with a usage line when --dir or --out is missing, and never prints a stack trace', () => {
    for (const args of [[], ['--dir', srcDir], ['--out', '/tmp/x'], ['--dir']]) {
      const r = cli(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(
        /usage: .*backup\.mjs --dir <pglite dir> --out <folder outside the repo>/,
      );
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
  });
});

describe('the command line', () => {
  it('backs up a real directory end to end, prints names and counts only, exits 0', () => {
    const out = join(fresh('o'), 'bk');
    const r = cli(['--dir', srcDir, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/backup ok/);
    expect(r.stdout).toContain('manifest.json');
    expect(readdirSync(out)).toHaveLength(3);
  }, 120_000);
});

describe('no secret and no personal data beyond what the database holds', () => {
  it('a planted secret in the environment reaches no file, no manifest, no log line', () => {
    const out = join(fresh('o'), 'bk');
    const env = {
      UMS_FAKE_SECRET: PLANTED,
      PAYPAL_FAKE_PLACEHOLDER: `${PLANTED}-b`,
      NODE_ENV: 'test',
    };
    const r = cli(['--dir', srcDir, '--out', out], env);
    expect(r.status, r.stderr).toBe(0);
    const seeds = [PLANTED, `${PLANTED}-b`];
    const manifest = readFileSync(join(out, 'manifest.json'), 'utf8');
    const sqlFile = readdirSync(out).find((f) => f.endsWith('.sql'))!;
    const tarFile = readdirSync(out).find((f) => f.endsWith('.tar.gz'))!;
    const sql = readFileSync(join(out, sqlFile), 'utf8');
    const tar = gunzipSync(readFileSync(join(out, tarFile)));
    for (const s of seeds) {
      expect(manifest).not.toContain(s);
      expect(sql).not.toContain(s);
      expect(r.stdout).not.toContain(s);
      expect(r.stderr).not.toContain(s);
      expect(tar.includes(Buffer.from(s))).toBe(false);
    }
    // The shapes of secrets and addresses: the log scan finds nothing in the manifest, the logs or the export.
    for (const [where, text] of [
      ['manifest', manifest],
      ['stdout', r.stdout],
      ['stderr', r.stderr],
      ['export', sql],
    ] as const) {
      expect(scanText(text, { seeds, where }), where).toEqual([]);
    }
  }, 120_000);

  it('the scanner itself still sees a planted secret and an address (the scan is live)', () => {
    expect(scanText(`token=${PLANTED}`, { seeds: [PLANTED] }).length).toBeGreaterThan(0);
    expect(scanText('mail me at someone@example.org').length).toBeGreaterThan(0);
  });

  it('the scripts read no environment variable and open no connection (source check)', () => {
    for (const f of ['backup.mjs']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/process\.env/);
      expect(src).not.toMatch(/\bfetch\s*\(|node:(net|tls|http|https|dns|dgram)/);
    }
  });
});
