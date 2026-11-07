// POB-LINKU on a real Postgres 16: two operators verify two publishers that asked for the same PayPal address
// at the same moment. PGlite runs one query at a time, so only a real server shows the race. Each round has a
// fresh address and two fresh publishers; the racers start in a seeded order. After every round exactly one
// link is verified and the other attempt got `email_in_use`; a second case races two plain SQL updates, where
// exactly one wins and the other fails with 23505. Runs only when UMS_TEST_PG_BIN is set, on a throwaway
// local server (unix socket in a temp directory); no byte leaves the machine.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decidePaypalLink } from '@umsbx/catalogue';
import { migrate, openDatabase } from '@umsbx/db';
import type { SqlDriver } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { Actor, AuditSink } from '@umsbx/contracts';
import { PG_ON, race, seeded, startTestPostgres } from './pg-support';
import type { TestPostgres } from './pg-support';

vi.mock('server-only', () => ({}));

const ROUNDS = 20;
const T = '2026-11-07T10:00:00Z';
const operator: Actor = { kind: 'operator', operator_id: 'opr_race', mfa: true };

describe.skipIf(!PG_ON)('POB-LINKU one verified address, racing operators, real Postgres', () => {
  let server: TestPostgres;
  let db: SqlDriver;
  let databaseUrl = '';
  beforeAll(async () => {
    server = await startTestPostgres();
    const created = await server.createDatabase('linku_race');
    databaseUrl = created.url;
    db = await openDatabase({ kind: 'postgres', url: created.url, pool_max: 6 });
    await migrate(db, { now: () => new Date(T) });
  }, 120_000);
  afterAll(async () => {
    await db?.close().catch(() => undefined);
    await server?.stop();
  });

  const clock = fakeClock(T);
  const ids = seededIds('linku');
  const audits: string[] = [];
  const audit: AuditSink = {
    async record(_tx, e) {
      audits.push(e.action);
    },
  };
  const deps = () => ({ db, clock, ids, audit });

  async function requested(n: number, email: string): Promise<string> {
    const id = `pub_race${String(n)}`;
    await db.query(
      `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
       VALUES ($1, $2, $2, 'GB', 'active', $3, $3)`,
      [id, `race-${String(n)}`, T],
    );
    await db.query(
      `INSERT INTO publisher_paypal_links (publisher_id, paypal_email, state, verified_by, verified_at, created_at, updated_at)
       VALUES ($1, $2, 'requested', NULL, NULL, $3, $3)`,
      [id, email, T],
    );
    return id;
  }
  const verifiedFor = async (email: string): Promise<number> =>
    (
      await db.query(
        `SELECT 1 FROM publisher_paypal_links WHERE state = 'verified' AND lower(btrim(paypal_email)) = $1`,
        [email],
      )
    ).rows.length;

  it(`${String(ROUNDS)} rounds: two decisions on one address give one verified and one email_in_use`, async () => {
    const rnd = seeded(20261107);
    let both = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const email = `race.${String(i)}@example.com`;
      const a = await requested(i * 2, email);
      const b = await requested(i * 2 + 1, email);
      const decide = (publisher_id: string) => () =>
        decidePaypalLink(deps(), operator, {
          publisher_id,
          email_retyped: email,
          reason: 'Confirmed by phone',
        });
      const results = await race(rnd, [decide(a), decide(b)]);
      const values = results.map((r) => {
        if (r.status === 'rejected') throw r.reason;
        return r.value;
      });
      const okCount = values.filter((v) => v.ok).length;
      const refused = values.filter((v) => !v.ok);
      expect(okCount, `round ${String(i)}`).toBe(1);
      expect(refused, `round ${String(i)}`).toEqual([
        { ok: false, error: { code: 'email_in_use' } },
      ]);
      expect(await verifiedFor(email)).toBe(1);
      both += 1;
    }
    expect(both).toBe(ROUNDS);
    // one audit row per success, none for the refused attempts
    expect(audits.filter((x) => x === 'publisher.paypal_link_verified')).toHaveLength(ROUNDS);
  }, 120_000);

  it('a verify that waits on the index while the other commits gets email_in_use and changes nothing (deterministic)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const email = `hold.${String(i)}@example.com`;
      const a = await requested(2000 + i * 2, email);
      const b = await requested(2000 + i * 2 + 1, email);
      const other = await openDatabase({ kind: 'postgres', url: databaseUrl, pool_max: 2 });
      try {
        let commitA!: () => void;
        const gate = new Promise<void>((r) => {
          commitA = r;
        });
        let aHolds!: () => void;
        const held = new Promise<void>((r) => {
          aHolds = r;
        });
        // A's session verifies the row and stays open; the unique index entry for the address is now taken.
        const aTx = other.transaction(async (tx) => {
          await tx.query(
            `UPDATE publisher_paypal_links
                SET state = 'verified', verified_by = 'opr_sql', verified_at = $2 WHERE publisher_id = $1`,
            [a, T],
          );
          aHolds();
          await gate;
        });
        await held;
        // B passes the pre-check (A is not committed, so invisible), then blocks on the index entry.
        const auditBefore = audits.length;
        const bDecision = decidePaypalLink(deps(), operator, {
          publisher_id: b,
          email_retyped: email,
          reason: 'Confirmed by phone',
        });
        let waited = false;
        for (let k = 0; k < 100 && !waited; k += 1) {
          waited =
            (
              await db.query(
                `SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
              )
            ).rows.length > 0;
          if (!waited) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waited, 'B must be waiting on the index while A is uncommitted').toBe(true);
        commitA();
        await aTx;
        expect(await bDecision).toEqual({ ok: false, error: { code: 'email_in_use' } });
        expect(
          (
            await db.query(
              'SELECT state, verified_by, verified_at FROM publisher_paypal_links WHERE publisher_id = $1',
              [b],
            )
          ).rows,
        ).toEqual([{ state: 'requested', verified_by: null, verified_at: null }]);
        expect(audits).toHaveLength(auditBefore);
        expect(await verifiedFor(email)).toBe(1);
      } finally {
        await other.close().catch(() => undefined);
      }
    }
  }, 120_000);

  it('plain SQL: two sessions verifying two rows with one address, exactly one wins with 23505 for the other', async () => {
    const rnd = seeded(7);
    for (let i = 0; i < ROUNDS; i += 1) {
      const email = `sql.race.${String(i)}@example.com`;
      const a = await requested(1000 + i * 2, email);
      const b = await requested(1000 + i * 2 + 1, email);
      const verify = (id: string) => () =>
        db.transaction(async (tx) => {
          await tx.query(
            `UPDATE publisher_paypal_links
                SET state = 'verified', verified_by = 'opr_sql', verified_at = $2 WHERE publisher_id = $1`,
            [id, T],
          );
          await new Promise((r) => setTimeout(r, 15)); // hold the row so the other session reaches the index
        });
      const results = await race(rnd, [verify(a), verify(b)]);
      expect(
        results.filter((r) => r.status === 'fulfilled'),
        `round ${String(i)}`,
      ).toHaveLength(1);
      const lost = results.filter((r) => r.status === 'rejected');
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: '23505' });
      expect(await verifiedFor(email)).toBe(1);
    }
  }, 120_000);
});
