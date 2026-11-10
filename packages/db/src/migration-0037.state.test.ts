// DOMAIN-PROOF-2 (D-116): migration 0037. Additive and forward-only. publisher_proof_codes (one permanent code per
// publisher, unique), publisher_domains gains verified_by / vouched_by / vouch_reason and the state `removed`.
// A verified row may become removed and nothing else; a removed row frees the host. No default, no now(), no write
// to a tracked (0023) table. Tolerates later migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

const T = '2026-11-10T10:00:00Z';
const T2 = '2026-11-10T11:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  return d;
}
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
async function publisher(d: Db, id: string): Promise<void> {
  await d.query(
    `INSERT INTO publishers (id, slug, display_name, country, created_at, updated_at)
     VALUES ($1, $2, $2, 'US', $3, $3)`,
    [id, id.replace('pub_', 'slug-'), T],
  );
}
const ins = (d: Db, table: string, r: Record<string, unknown>): Promise<unknown> => {
  const cols = Object.keys(r);
  return d.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
};
const domain = (d: Db, o: Record<string, unknown> = {}) =>
  ins(d, 'publisher_domains', {
    id: 'pdm_1',
    publisher_id: 'pub_a',
    host: 'shop.pub-one.invalid',
    token_hash: SHA,
    state: 'pending',
    requested_at: T,
    verified_at: null,
    verified_by: null,
    vouched_by: null,
    vouch_reason: null,
    created_at: T,
    updated_at: T,
    ...o,
  });
const bad = async (p: Promise<unknown>): Promise<void> => {
  await expect(p).rejects.toThrow();
};
const code = (c: string): string => `umv-${c.repeat(32)}`;
const code1 = (): { publisher_id: string; code: string; created_at: string } => ({
  publisher_id: 'pub_a',
  code: code('1'),
  created_at: T,
});
const verified = (extra: Record<string, unknown>): Record<string, unknown> => ({
  state: 'verified',
  verified_at: T,
  ...extra,
});

describe('migration 0037', () => {
  it('is applied once, after 0035, forward-only, no default, no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    const name = first.find((n) => n.startsWith('0037_'));
    expect(name).toBeDefined();
    expect(first.indexOf(name!)).toBeGreaterThan(first.indexOf('0035_web_import_switch'));
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    const file = readdirSync(dir).find((n) => n.startsWith('0037_'))!;
    expect(readdirSync(dir).filter((n) => /^0037_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL(file, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
  });

  it('publisher_proof_codes: one code per publisher, a code belongs to one publisher, the token shape', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await ins(d, 'publisher_proof_codes', code1());
    await bad(ins(d, 'publisher_proof_codes', { ...code1(), code: code('2') }));
    await bad(ins(d, 'publisher_proof_codes', { ...code1(), publisher_id: 'pub_b' }));
    await bad(
      ins(d, 'publisher_proof_codes', { ...code1(), publisher_id: 'pub_b', code: 'short' }),
    );
    await bad(
      ins(d, 'publisher_proof_codes', { ...code1(), publisher_id: 'pub_zz', code: code('3') }),
    );
    await ins(d, 'publisher_proof_codes', { ...code1(), publisher_id: 'pub_b', code: code('3') });
  });

  it('the proof code never changes once written', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await ins(d, 'publisher_proof_codes', code1());
    await bad(
      d.query('UPDATE publisher_proof_codes SET code = $1 WHERE publisher_id = $2', [
        code('9'),
        'pub_a',
      ]),
    );
  });

  it('state takes removed; verified_by is proof or operator; operator needs who and why', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    const h = (n: string): string => `${n}.pub-one.invalid`;
    await domain(d, { id: 'pdm_r', host: h('r'), state: 'removed' });
    await bad(domain(d, { id: 'pdm_x', host: h('x'), state: 'bogus' }));
    await bad(domain(d, { id: 'pdm_y', host: h('y'), ...verified({ verified_by: 'magic' }) }));
    await bad(domain(d, { id: 'pdm_z', host: h('z'), ...verified({ verified_by: 'operator' }) }));
    await bad(
      domain(d, {
        id: 'pdm_w',
        host: h('w'),
        ...verified({ verified_by: 'operator', vouched_by: 'opr_vikram', vouch_reason: 'ab' }),
      }),
    );
    await domain(d, {
      id: 'pdm_ok',
      host: h('ok'),
      ...verified({
        verified_by: 'operator',
        vouched_by: 'opr_vikram',
        vouch_reason: 'Checked on a call',
      }),
    });
    await domain(d, { id: 'pdm_p', host: h('p'), ...verified({ verified_by: 'proof' }) });
    await bad(
      domain(d, {
        id: 'pdm_q',
        host: h('q'),
        ...verified({
          verified_by: 'proof',
          vouched_by: 'opr_vikram',
          vouch_reason: 'Checked on a call',
        }),
      }),
    );
    // an old verified row (verified_by null) is still valid
    await domain(d, { id: 'pdm_old', host: h('old'), ...verified({}) });
    // pending still has no verified_at
    await bad(domain(d, { id: 'pdm_n', host: h('n'), verified_at: T }));
  });

  it('the guard: verified may become removed and nothing else; removed may become pending again', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await domain(d, verified({ verified_by: 'proof' }));
    await bad(
      d.query("UPDATE publisher_domains SET state = 'pending', verified_at = NULL WHERE id = 'pdm_1'"),
    );
    await bad(d.query("UPDATE publisher_domains SET token_hash = $1 WHERE id = 'pdm_1'", [SHA2]));
    await bad(
      d.query("UPDATE publisher_domains SET host = 'other.pub-one.invalid' WHERE id = 'pdm_1'"),
    );
    await bad(d.query("UPDATE publisher_domains SET verified_by = 'operator' WHERE id = 'pdm_1'"));
    await d.query("UPDATE publisher_domains SET state = 'removed', updated_at = $1 WHERE id = 'pdm_1'", [
      T2,
    ]);
    const r = await d.query<{ state: string; verified_at: unknown; token_hash: string }>(
      'SELECT state, verified_at, token_hash FROM publisher_domains WHERE id = $1',
      ['pdm_1'],
    );
    expect(r.rows[0]).toMatchObject({ state: 'removed', token_hash: SHA });
    expect(r.rows[0]!.verified_at).not.toBeNull();
    await bad(d.query("UPDATE publisher_domains SET state = 'verified' WHERE id = 'pdm_1'"));
    await d.query(
      "UPDATE publisher_domains SET state = 'pending', verified_at = NULL, verified_by = NULL, token_hash = $1, requested_at = $2, updated_at = $2 WHERE id = 'pdm_1'",
      [SHA2, T2],
    );
    await bad(d.query("UPDATE publisher_domains SET publisher_id = 'pub_b' WHERE id = 'pdm_1'"));
  });

  it('a removed row frees the host: another publisher may verify it, one verified owner still holds', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await domain(d, verified({ verified_by: 'proof' }));
    const theirs = { id: 'pdm_2', publisher_id: 'pub_b', ...verified({ verified_by: 'proof' }) };
    await bad(domain(d, theirs));
    await d.query("UPDATE publisher_domains SET state = 'removed' WHERE id = 'pdm_1'");
    await domain(d, theirs);
    await bad(domain(d, { id: 'pdm_3', publisher_id: 'pub_a', ...verified({ verified_by: 'proof' }) }));
  });

  it('writes nothing to a tracked table: a fresh database holds no non-backfill trace event', async () => {
    const d = await fresh();
    const r = await d.query<{ c: string | number }>(
      "SELECT count(*) AS c FROM trace_events WHERE NOT (actor_kind = 'system' AND channel = 'backfill')",
    );
    expect(Number(r.rows[0]!.c)).toBe(0);
  });
});
