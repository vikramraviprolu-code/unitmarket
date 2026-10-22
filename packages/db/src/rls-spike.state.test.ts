// RLS spike (informational, NOT a gate): does PGlite enforce policies under SET ROLE?
// The result is printed and recorded in docs/READINESS.md by hand; this test never fails on it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from './index';

describe('RLS spike (informational)', () => {
  it('reports whether PGlite enforces the supabase policy file under SET ROLE', async () => {
    const db = await openDatabase({ kind: 'pglite-memory' });
    const outcome: Record<string, unknown> = {};
    try {
      await migrate(db, { now: () => new Date('2026-10-21T10:00:00Z') });
      const T = '2026-10-21T10:00:00Z';
      for (const b of ['buy_a', 'buy_b']) {
        await db.query('INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1, $1, $1, $2, $3, $3)', [b, 'US', T]);
      }
      await db.exec(readFileSync(new URL('../migrations/supabase/0001_roles_rls.sql', import.meta.url), 'utf8'));
      outcome.policyFileApplies = true;
      await db.exec("GRANT USAGE ON SCHEMA public TO ums_app");
      await db.exec('SET ROLE ums_app');
      await db.query("SELECT set_config('ums.actor_kind', 'buyer', false), set_config('ums.actor_id', 'buy_a', false)");
      const rows = await db.query<{ id: string }>('SELECT id FROM buyers ORDER BY id');
      await db.exec('RESET ROLE');
      outcome.rowsVisibleToBuyerA = rows.rows.map((r) => r.id);
      outcome.rlsEnforced = rows.rows.length === 1 && rows.rows[0]!.id === 'buy_a';
    } catch (e) {
      outcome.error = String(e instanceof Error ? e.message : e);
    } finally {
      await db.close();
    }
    console.log('RLS_SPIKE_RESULT ' + JSON.stringify(outcome));
    expect(outcome).toBeTypeOf('object');
  });
});
