// CO-6 test support (not exported from index). Fixed fake TOTP keys, an independent RFC 6238 oracle
// that the tests use to make codes (so a bug in totp.ts cannot hide behind itself), and a rig whose
// audit sink writes the real audit_log table, because the replay check reads that table. The audit
// table is append-only, so one database serves a test file and each rig gets its own hour of the
// fake clock: a step used in one test is never a step of another.
import { createHmac } from 'node:crypto';
import { afterAll } from 'vitest';
import type { AuditSink, Secret } from '@umsbx/contracts';
import { migrate, openDatabase, type SqlDriver } from '@umsbx/db';
import { fakeClock, makeRig, seededIds, secret, type TestRig } from './test-support';

// RFC 6238 appendix B uses the ASCII key "12345678901234567890"; the second is another fixed string.
// Neither is a credential: both are test values.
export const VIKRAM_KEY = Buffer.from('12345678901234567890', 'ascii');
export const SAKTHI_KEY = Buffer.from('ABCDEFGHIJKLMNOPQRST', 'ascii');
export const VIKRAM_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
export const SAKTHI_B32 = 'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U';

export const KEYS: ReadonlyArray<{ name: string; key: Secret }> = [
  { name: 'vikram', key: secret(VIKRAM_B32) },
  { name: 'sakthi', key: secret(SAKTHI_B32) },
];

export const STEP_MS = 30_000;
export const MIN = 60_000;

/** HOTP truncation written out once more, independently of totp.ts. */
export function oracleCode(key: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[19] ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const stepOf = (ms: number): number => Math.floor(ms / STEP_MS);

let shared: SqlDriver | null = null;
let rigNo = 0;
afterAll(async () => {
  await shared?.close();
  shared = null;
});

const BASE_MS = Date.parse('2026-10-22T09:00:00.000Z');

export interface TotpRig extends TestRig {
  /** The first instant of this rig's hour; audit rows of other rigs are older or newer. */
  from: string;
  to: string;
  /** The current step of the rig's fake clock. */
  step(): number;
  /** The code for `step + delta`, made by the oracle. */
  code(key: Buffer, delta?: number): string;
}

export async function totpRig(): Promise<TotpRig> {
  const no = rigNo++;
  const clock = fakeClock(new Date(BASE_MS + no * 60 * MIN).toISOString());
  if (shared === null) {
    shared = await openDatabase({ kind: 'pglite-memory' });
    await migrate(shared, clock);
  }
  await shared.exec('TRUNCATE sessions, rate_buckets, api_idempotency');
  const ids = seededIds(`totp-audit-${no}`);
  const audit: AuditSink = {
    async record(tx, e) {
      await tx.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [
          ids.next('aud'),
          e.actor.kind,
          e.actor.kind === 'operator' ? e.actor.operator_id : null,
          e.action,
          e.target,
          e.reason,
          JSON.stringify({
            ...e.detail,
            ...(e.actor.kind === 'operator' ? { actor_mfa: e.actor.mfa } : {}),
          }),
          clock.now().toISOString(),
        ],
      );
    },
  };
  const rig = await makeRig({ db: shared, clock, audit });
  const from = new Date(BASE_MS + no * 60 * MIN).toISOString();
  const to = new Date(BASE_MS + (no + 1) * 60 * MIN).toISOString();
  const step = (): number => stepOf(clock.now().getTime());
  return {
    ...rig,
    from,
    to,
    clock,
    step,
    code: (key, delta = 0) => oracleCode(key, step() + delta),
  };
}

export interface AuditRow {
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export async function usedRows(rig: TotpRig, operator_id?: string): Promise<AuditRow[]> {
  const res = await rig.db.query<AuditRow>(
    `SELECT actor_kind, actor_id, action, target, reason, detail FROM audit_log
      WHERE action = 'operator.totp_used' AND created_at >= $1 AND created_at < $2
        ${operator_id === undefined ? '' : 'AND actor_id = $3'}
      ORDER BY created_at, id`,
    operator_id === undefined ? [rig.from, rig.to] : [rig.from, rig.to, operator_id],
  );
  return res.rows;
}

/** Everything a sign-in could have written down, as one string, for "no key and no code in it" checks. */
export async function everythingWritten(rig: TotpRig): Promise<string> {
  const audit = await rig.db.query(
    'SELECT * FROM audit_log WHERE created_at >= $1 AND created_at < $2',
    [rig.from, rig.to],
  );
  const buckets = await rig.db.query('SELECT * FROM rate_buckets');
  const sessions = await rig.db.query('SELECT * FROM sessions');
  return JSON.stringify({
    logs: rig.log.events,
    audit: audit.rows,
    buckets: buckets.rows,
    sessions: sessions.rows,
  });
}
