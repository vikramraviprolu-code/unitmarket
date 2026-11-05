// INT-TR0 / TR0.2: the operator CLI entry points. The mains open a CLI context (channel cli, actor operator,
// id cli:<os user hash>) around the database they use. The two writes that matter here, safety:stop and
// privacy:delete, are run through the same functions the mains call, on a database wrapped the way the mains
// wrap it, and the journal must name the operator and the cli channel. The mains themselves need a terminal
// and refuse in CI, so a text check pins that each of the three opens the context and none of the safety
// package does (packages/safety stays barred from @umsbx/obs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTraceDb } from '../packages/db/src/trace-db';
import { createAuditSink } from '../packages/obs/src/index';
import { cliTraceContext } from '../packages/obs/src/trace-context';
import { runStop } from '../packages/safety/src/index';
import { runDelete } from './lib/privacy.mjs';
import { T, clock, freshDb, ins } from '../packages/db/src/trace-test-support';
import type { Db } from '../packages/db/src/trace-test-support';
import { REPO_ROOT } from './test-helpers';

const TTY = { isTTY: true, env: {} as Record<string, string | undefined> };
const ids = { next: (p: string) => `${p}_cli_${++n}`, nonce: () => 'nonce' };
let n = 0;
let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const cliDb = (job: string) =>
  withTraceDb(
    db,
    () => cliTraceContext({ id: `ctx_cli_${job}`, at: T, user_hash: 'ab'.repeat(8), job }),
    clock,
  );

describe('safety:stop', () => {
  it('journals the switch change and its audit row as operator on the cli channel', async () => {
    const traced = cliDb('safety:stop');
    const r = await runStop({
      db: traced,
      clock,
      audit: createAuditSink(ids as never, clock),
      tty: TTY,
      by: { kind: 'operator', operator_id: 'opr_cli', mfa: true },
      reason: 'CANARY-SWITCH-REASON',
    });
    expect(r.ok).toBe(true);
    const rows = (
      await db.query<{
        source_table: string;
        actor_kind: string;
        actor_id: string;
        channel: string;
        ctx_id: string;
      }>(
        "SELECT source_table, actor_kind, actor_id, channel, ctx_id FROM trace_events WHERE ctx_id = 'ctx_cli_safety:stop' ORDER BY chain_key, seq",
      )
    ).rows;
    expect(rows.map((x) => x.source_table).sort()).toEqual(['audit_log', 'safety_switches']);
    for (const x of rows)
      expect(x).toMatchObject({
        actor_kind: 'operator',
        actor_id: `cli:${'ab'.repeat(8)}`,
        channel: 'cli',
      });
    const cx = await db.query(
      "SELECT job, channel, actor_kind FROM trace_context WHERE id = 'ctx_cli_safety:stop'",
    );
    expect(cx.rows[0]).toEqual({ job: 'safety:stop', channel: 'cli', actor_kind: 'operator' });
  });
});

describe('privacy:delete', () => {
  it('journals the audit row it writes as operator on the cli channel', async () => {
    await ins(db, 'buyers', {
      id: 'buy_cli',
      display_name: 'Ada',
      auth_subject: 'sub-cli',
      country: 'US',
    });
    const traced = cliDb('privacy:delete');
    const r = await runDelete({
      db: traced,
      clock,
      audit: createAuditSink(ids as never, clock),
      tty: TTY,
      ask: async () => 'buy_cli',
      write: () => undefined,
      buyer_id: 'buy_cli',
      operator_id: 'opr_cli',
      reason: 'erasure request',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const rows = (
      await db.query<{ source_table: string; actor_kind: string; channel: string }>(
        "SELECT source_table, actor_kind, channel FROM trace_events WHERE ctx_id = 'ctx_cli_privacy:delete'",
      )
    ).rows;
    expect(rows).toEqual([{ source_table: 'audit_log', actor_kind: 'operator', channel: 'cli' }]);
  });
});

describe('the three mains open the cli context', () => {
  const mains = ['safety-cli-main.mjs', 'privacy-main.mjs', 'accounts-cli-main.mjs'];
  it.each(mains)('%s wraps its database with withTraceDb and a cli context', (file) => {
    const text = readFileSync(join(REPO_ROOT, 'scripts/lib', file), 'utf8');
    expect(text).toContain('withTraceDb');
    expect(text).toContain('cliTraceContext');
    expect(text).toMatch(/user_hash/);
  });

  it('the safety package does not import @umsbx/obs', () => {
    const files = ['cli-stop.ts', 'index.ts'];
    for (const f of files) {
      expect(readFileSync(join(REPO_ROOT, 'packages/safety/src', f), 'utf8')).not.toContain(
        '@umsbx/obs',
      );
    }
  });
});
