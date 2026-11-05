// CO-10: restore round trip, offline. A seeded database is backed up, then restored from the
// tarball and from the logical export into fresh directories. Row counts and ledger sums match, the
// append-only triggers and the unique indexes hold after restore, a changed byte in either file
// refuses, a non-empty target refuses, and the restore stays far inside the 30 s test budget.
import { spawn, spawnSync } from 'node:child_process';
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
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase, withTraceDb } from '../packages/db/src/index';
import { cliTraceContext } from '../packages/obs/src/trace-context';
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
  const raw = await openDatabase({ kind: 'pglite-disk', dir: src });
  await migrate(raw, clock);
  // INT-TR0: the seeded world is written under a cli context, so the backup holds no unattributed journal row.
  const seedCtx = cliTraceContext({ id: 'ctx_restore_seed', at: T, user_hash: 'ab'.repeat(8) });
  const db = withTraceDb(raw, () => seedCtx, clock);
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
  // The H1 probe: outbound switched on and an approval valid to 2099 at backup time.
  await ins(db, 'outbound_approvals', {
    id: 'oap_1',
    approval_ref: 'probe-ref-2099',
    scope: 'sandbox',
    operations: ['create_order'],
    max_amount_minor: 100000,
    max_calls_per_day: 50,
    valid_until: '2099-01-01T00:00:00Z',
    approved_by: 'attacker',
  });
  await db.query('UPDATE safety_switches SET "on" = true WHERE name = \'paypal_outbound\'');
  counts = await rowCounts(db);
  sums = await ledgerSums(db);
  await db.close();
  backupDir = fresh('bk');
  rmSync(backupDir, { recursive: true });
  await runBackup({ appStopped: true, dir: src, out: backupDir, clock });
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
  // The restore itself leaves no opener lock behind. Checked before opening: since CO-9 an open
  // database holds the lock while it is open.
  expect(existsSync(join(dir, '.ums-open.lock'))).toBe(false);
  const db = await openDatabase({ kind: 'pglite-disk', dir });
  try {
    // The restore adds exactly one audit row of its own (the switch change).
    // The journal records both of the restore's writes (the audit row and the switch change) as system on cli.
    expect(await rowCounts(db)).toEqual({
      ...counts,
      audit_log: (counts['audit_log'] ?? 0) + 1,
      trace_events: (counts['trace_events'] ?? 0) + 2,
      trace_context: (counts['trace_context'] ?? 0) + 1,
      trace_heads: expect.any(Number),
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM trace_events WHERE actor_kind = 'unattributed'",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect(await ledgerSums(db)).toEqual(sums);
    // H1: a restore never leaves outbound PayPal switched on; the approval row is kept but inert.
    const sw = await db.query(
      'SELECT "on", changed_by, reason FROM safety_switches WHERE name = \'paypal_outbound\'',
    );
    expect(sw.rows).toEqual([
      { on: false, changed_by: 'restore', reason: expect.stringMatching(/restore/i) },
    ]);
    expect((await db.query('SELECT approval_ref FROM outbound_approvals')).rows).toEqual([
      { approval_ref: 'probe-ref-2099' },
    ]);
    // R2: the restore's own switch change is on the audit trail, ids only.
    const audit = await db.query(
      "SELECT actor_kind, actor_id, action, target, detail FROM audit_log WHERE action = 'restore.disarm_outbound'",
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: 'system',
        actor_id: 'restore',
        action: 'restore.disarm_outbound',
        target: 'paypal_outbound',
        detail: { switch_was_on: true, approval_ids: ['oap_1'] },
      },
    ]);
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
    const res = await runRestore({ from: backupDir, dir, clock, allowLiveApprovals: true });
    const seconds = (wall.now().getTime() - t0) / 1000;
    expect(res.mode).toBe('tarball');
    expect(res.outbound.switch_was_on).toBe(true);
    expect(res.outbound.approvals).toEqual([
      expect.objectContaining({ ref: 'probe-ref-2099', scope: 'sandbox' }),
    ]);
    expect(res.tables).toEqual(counts);
    expect(seconds).toBeLessThan(30);
    await verifyRestored(dir);
  }, 180_000);
});

describe('SQL restore', () => {
  it('imports the logical export into a fresh database with identical counts and ledger sums', async () => {
    const dir = target();
    const t0 = wall.now().getTime();
    const res = await runRestore({
      from: backupDir,
      dir,
      sql: true,
      clock,
      allowLiveApprovals: true,
    });
    const seconds = (wall.now().getTime() - t0) / 1000;
    expect(res.mode).toBe('sql');
    expect(res.outbound.switch_was_on).toBe(true);
    expect(res.outbound.approvals).toEqual([
      expect.objectContaining({ ref: 'probe-ref-2099', scope: 'sandbox' }),
    ]);
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
      await expect(runRestore({ from, dir, sql, clock, allowLiveApprovals: true })).rejects.toThrow(
        /row count|count/i,
      );
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
    const ok = cli(['--from', backupDir, '--dir', dir, '--allow-live-approvals']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/restore ok \(tarball\)/);
    expect(ok.stdout).not.toMatch(/WITH WARNINGS/);
    // Each warning is printed once, on stderr only.
    expect(ok.stdout).not.toContain('probe-ref-2099');
    expect(ok.stderr).toContain('probe-ref-2099');
    expect(ok.stderr.match(/WARNING: paypal_outbound/g)).toHaveLength(1);
    expect(ok.stderr).toMatch(/re-activates/);
    const again = cli(['--from', backupDir, '--dir', dir, '--allow-live-approvals']);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/not empty/i);
    const bad = cli(['--from', backupDir]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/usage: .*restore\.mjs --from <folder> --dir <empty dir>/);
    expect(bad.stderr).not.toMatch(/\n\s+at /);
  }, 180_000);

  it('--sql restores from the logical export', () => {
    const dir = target();
    const r = cli(['--from', backupDir, '--dir', dir, '--sql', '--allow-live-approvals']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/restore ok.*sql/i);
  }, 180_000);

  it('the script reads no environment variable and opens no connection (source check)', () => {
    const src = readFileSync(join(__dirname, 'restore.mjs'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\bfetch\s*\(|node:(net|tls|http|https|dns|dgram)/);
  });
});

describe('restore re-checks what it loads (M2, L2, L3)', () => {
  async function backupOf(prep: (db: Q) => Promise<void>): Promise<string> {
    const src = fresh('guard-src');
    const db = await openDatabase({ kind: 'pglite-disk', dir: src });
    await migrate(db, clock);
    await prep(db);
    await db.close();
    const out = join(fresh('guard-out'), 'bk');
    await runBackup({ appStopped: true, dir: src, out, clock, warn: () => {} });
    return out;
  }

  it('a source with the ledger guards switched off: the tarball restore refuses, the SQL restore re-enables them', async () => {
    const from = await backupOf((db) => db.exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER'));
    const bad = target();
    await expect(runRestore({ from, dir: bad, clock })).rejects.toThrow(/trigger/i);
    expect(!existsSync(bad) || readdirSync(bad).length === 0).toBe(true);
    const good = target();
    await runRestore({ from, dir: good, sql: true, clock });
    const db = await openDatabase({ kind: 'pglite-disk', dir: good });
    try {
      const off = await db.query(
        "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'",
      );
      expect(off.rows).toEqual([]);
    } finally {
      await db.close();
    }
  }, 240_000);

  it('a source with a guard trigger missing: the tarball restore refuses and names it', async () => {
    const from = await backupOf((db) => db.exec('DROP TRIGGER receipts_immutable ON receipts'));
    const bad = target();
    await expect(runRestore({ from, dir: bad, clock })).rejects.toThrow(
      /missing.*receipts_immutable/is,
    );
    expect(!existsSync(bad) || readdirSync(bad).length === 0).toBe(true);
  }, 240_000);

  it('a tarball whose migration version differs from the manifest refuses', async () => {
    const from = copyBackup();
    const m = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
    m.migration_version = '0001_core';
    writeFileSync(join(from, 'manifest.json'), JSON.stringify(m));
    const bad = target();
    await expect(runRestore({ from, dir: bad, clock })).rejects.toThrow(/migration version/i);
    expect(!existsSync(bad) || readdirSync(bad).length === 0).toBe(true);
  }, 180_000);

  it('--sql prints no "newer migrations" note (every migration is new on a fresh database)', async () => {
    const warnings: string[] = [];
    await runRestore({
      from: backupDir,
      dir: target(),
      sql: true,
      clock,
      allowLiveApprovals: true,
      warn: (m: string) => warnings.push(m),
    });
    expect(warnings.join('\n')).not.toMatch(/newer migration/i);
  }, 180_000);

  it('a target inside the repository is refused, like the backup output folder', async () => {
    const dir = join(ROOT, '.sbx-local', 'co10-restore-should-not-exist');
    await expect(runRestore({ from: backupDir, dir, clock })).rejects.toThrow(/repository/i);
    expect(existsSync(dir)).toBe(false);
  });

  it('prints the outbound warning through warn as well: switch was on, approval refs, not carried live', async () => {
    const warnings: string[] = [];
    await runRestore({
      from: backupDir,
      dir: target(),
      clock,
      allowLiveApprovals: true,
      warn: (m: string) => warnings.push(m),
    });
    const text = warnings.join('\n');
    expect(text).toContain('probe-ref-2099');
    expect(text).toMatch(/paypal_outbound/);
    expect(text).toMatch(/re-activates/i);
    expect(text).not.toMatch(/not carried live/i);
  }, 180_000);
});

describe('an interrupted restore never leaves an armed or half-written target (R1)', () => {
  const partialsOf = (dir: string) =>
    readdirSync(dirname(dir)).filter((n) => n.startsWith(`${basename(dir)}.partial-`));

  it('restores into a sibling <dir>.partial-<stamp> and renames it into place at the end', async () => {
    const dir = target();
    let during: string[] = [];
    let targetDuring = true;
    await runRestore({
      from: backupDir,
      dir,
      clock,
      allowLiveApprovals: true,
      onPoint: (p: string) => {
        if (p === 'loaded') {
          during = partialsOf(dir);
          targetDuring = existsSync(dir);
        }
      },
    });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatch(/\.partial-\d{8}T\d{6}Z$/);
    expect(targetDuring).toBe(false);
    expect(partialsOf(dir)).toEqual([]);
    expect(existsSync(join(dir, 'PG_VERSION'))).toBe(true);
  }, 180_000);

  for (const point of [
    'partial-created',
    'loaded',
    'migrated',
    'guards-checked',
    'counts-ok',
    'disarmed',
  ]) {
    for (const [sql, signal, code] of [
      [false, 'SIGINT', 130],
      [true, 'SIGTERM', 143],
    ] as const) {
      if (point === 'loaded' && sql) continue;
      it(`a ${signal} at "${point}" (${sql ? 'sql' : 'tarball'}) leaves no target and no partial`, async () => {
        const dir = target();
        const signals = new EventEmitter();
        const exits: number[] = [];
        let partialsAtExit = -1;
        const run = runRestore({
          from: backupDir,
          dir,
          sql,
          clock,
          allowLiveApprovals: true,
          signals,
          exit: (c: number) => {
            exits.push(c);
            // A real process.exit does not unwind: the handler must already have removed the partial.
            partialsAtExit = partialsOf(dir).length;
            throw new Error(`exit ${c}`);
          },
          onPoint: (p: string) => {
            if (p === point) signals.emit(signal);
          },
        });
        await expect(run).rejects.toThrow(`exit ${code}`);
        expect(exits[0]).toBe(code);
        expect(partialsAtExit).toBe(0);
        expect(existsSync(dir)).toBe(false);
        expect(partialsOf(dir)).toEqual([]);
        expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
      }, 180_000);
    }
  }

  it('a real SIGINT to the command line ends with exit 130, no target and no partial', async () => {
    const dir = target();
    const child = spawn(
      process.execPath,
      ['scripts/restore.mjs', '--from', backupDir, '--dir', dir, '--allow-live-approvals'],
      { cwd: ROOT, env: {}, stdio: 'ignore' },
    );
    const done = new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
    for (let i = 0; i < 2000 && partialsOf(dir).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(partialsOf(dir)).toHaveLength(1);
    child.kill('SIGINT');
    expect(await done).toBe(130);
    expect(existsSync(dir)).toBe(false);
    expect(partialsOf(dir)).toEqual([]);
  }, 180_000);

  it('a partial left by an earlier run (SIGKILL) is never touched or used, and the next run prints its path', async () => {
    const dir = target();
    mkdirSync(dirname(dir), { recursive: true });
    const old = `${dir}.partial-20200101T000000Z`;
    mkdirSync(old);
    writeFileSync(join(old, 'PG_VERSION'), '17\n');
    const warnings: string[] = [];
    await runRestore({
      from: backupDir,
      dir,
      clock,
      allowLiveApprovals: true,
      warn: (m: string) => warnings.push(m),
    });
    expect(warnings.join('\n')).toContain(old);
    expect(warnings.join('\n')).toMatch(/never use|do not use/i);
    expect(readFileSync(join(old, 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(existsSync(join(dir, 'PG_VERSION'))).toBe(true);
  }, 180_000);

  it('refuses when the final target appeared and is not empty meanwhile; removes its partial; keeps theirs', async () => {
    const dir = target();
    await expect(
      runRestore({
        from: backupDir,
        dir,
        clock,
        allowLiveApprovals: true,
        onPoint: (p: string) => {
          if (p === 'counts-ok') {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'theirs.txt'), 'theirs');
          }
        },
      }),
    ).rejects.toThrow(/appeared while restoring/);
    expect(readdirSync(dir)).toEqual(['theirs.txt']);
    expect(partialsOf(dir)).toEqual([]);
  }, 180_000);
});

describe('live outbound approvals (R2)', () => {
  async function backupWithApproval(validUntil: string): Promise<string> {
    const src = fresh('appr-src');
    const db = await openDatabase({ kind: 'pglite-disk', dir: src });
    await migrate(db, clock);
    await ins(db, 'outbound_approvals', {
      id: 'oap_9',
      approval_ref: 'ref-live-check',
      scope: 'sandbox',
      operations: ['create_order'],
      max_amount_minor: 100,
      max_calls_per_day: 5,
      valid_until: validUntil,
      approved_by: 'owner',
    });
    await db.query('UPDATE safety_switches SET "on" = true WHERE name = \'paypal_outbound\'');
    await db.close();
    const out = join(fresh('appr-out'), 'bk');
    await runBackup({ appStopped: true, dir: src, out, clock, warn: () => {} });
    return out;
  }

  it('refuses a backup with an approval valid in the future unless --allow-live-approvals, naming the refs', async () => {
    const from = await backupWithApproval('2099-01-01T00:00:00Z');
    for (const sql of [false, true]) {
      const dir = target();
      await expect(runRestore({ from, dir, sql, clock })).rejects.toThrow(/ref-live-check/);
      await expect(runRestore({ from, dir, sql, clock })).rejects.toThrow(/--allow-live-approvals/);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(dirname(dir)).filter((n) => n.includes('.partial-'))).toEqual([]);
    }
  }, 300_000);

  it('the command line refuses it with exit 1 and accepts it with the flag', () => {
    const dir = target();
    const r = spawnSync(
      process.execPath,
      ['scripts/restore.mjs', '--from', backupDir, '--dir', dir],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {},
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--allow-live-approvals/);
    expect(r.stderr).toContain('probe-ref-2099');
    expect(existsSync(dir)).toBe(false);
  }, 180_000);

  it('an expired approval restores without the flag; the switch is still forced off', async () => {
    const from = await backupWithApproval('2000-01-01T00:00:00Z');
    const dir = target();
    const res = await runRestore({ from, dir, clock });
    expect(res.outbound.switch_was_on).toBe(true);
    const db = await openDatabase({ kind: 'pglite-disk', dir });
    try {
      expect(
        (await db.query('SELECT "on" FROM safety_switches WHERE name = \'paypal_outbound\'')).rows,
      ).toEqual([{ on: false }]);
    } finally {
      await db.close();
    }
  }, 180_000);
});

describe('warnings are counted (nits)', () => {
  it('the command line says WITH WARNINGS when the tarball restore found an invariant break', async () => {
    const from = await (async () => {
      const src = fresh('inv-src');
      const db = await openDatabase({ kind: 'pglite-disk', dir: src });
      await migrate(db, clock);
      await ins(db, 'publishers', {
        id: 'pub_1',
        slug: 'p1',
        display_name: 'P',
        country: 'US',
        paypal_merchant_id: 'M1',
        payee_verified_at: T,
      });
      await ins(db, 'buyers', {
        id: 'buy_1',
        display_name: 'B',
        auth_subject: 'sub1',
        country: 'US',
      });
      await ins(db, 'approvals', {
        id: 'apr_1',
        buyer_id: 'buy_1',
        snapshot: j({ v: 1 }),
        content_hash: HASH,
        nonce: 'n1',
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
      // Verified capture with no ledger sale: INV1 is broken in the source.
      await ins(db, 'order_units', {
        id: 'unt_1',
        order_id: 'ord_1',
        provider_order_ref: null,
        publisher_id: 'pub_1',
        reference_id: 'r1',
        payee_merchant_id: 'M1',
        amount_minor: 500,
        platform_fee_minor: 0,
        capture_id: 'CAPX',
        status: 'captured_verified',
        status_reason: null,
        paypal_fee_minor: null,
        refunded_minor: 0,
        captured_verified_at: T,
        mismatch_reason: null,
      });
      await db.close();
      const out = join(fresh('inv-out'), 'bk');
      await runBackup({ appStopped: true, dir: src, out, clock, warn: () => {} });
      return out;
    })();
    const r = spawnSync(
      process.execPath,
      ['scripts/restore.mjs', '--from', from, '--dir', target()],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {},
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/restore ok \(tarball\) WITH WARNINGS/);
    expect(r.stderr).toMatch(/INV1/);
    expect(r.stderr.match(/INV1/g)).toHaveLength(1);
  }, 240_000);
});
