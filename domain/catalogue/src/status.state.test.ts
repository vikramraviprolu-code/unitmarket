// PUB-D: suspend and reactivate a publisher (operator only). PGlite with the base seed. Suspension hides
// the publisher's offers from the authorised list and ends its open quotes; it never touches orders,
// units, entitlements or the ledger. One audit row per change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuthorisedOffers } from './read';
import { setPublisherStatus } from './status';
import { count, offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const listed = async (): Promise<string[]> =>
  (await listAuthorisedOffers(w.db, { corridor_id: 'us-usd', limit: 500 })).map((v) => v.offer.id);
const statusOf = async (id: string): Promise<string> =>
  (await w.db.query<{ status: string }>('SELECT status FROM publishers WHERE id = $1', [id]))
    .rows[0]!.status;
const audits = async (action: string) =>
  (
    await w.db.query<{
      actor_kind: string;
      actor_id: string;
      target: string;
      reason: string;
      detail: Record<string, unknown>;
    }>('SELECT actor_kind, actor_id, target, reason, detail FROM audit_log WHERE action = $1', [
      action,
    ])
  ).rows;

describe('setPublisherStatus', () => {
  it('suspend hides every offer of that publisher from the list and no other', async () => {
    const before = await listed();
    expect(before.some((id) => id.startsWith('ofr_harbour-ledger_'))).toBe(true);
    expect(before.some((id) => id.startsWith('ofr_quayside-gazette_'))).toBe(true);
    const r = await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'suspended',
      reason: 'Complaint under review',
    });
    expect(r).toEqual({ ok: true, value: { status: 'suspended' } });
    expect(await statusOf(w.pubId['harbour-ledger'])).toBe('suspended');
    const after = await listed();
    expect(after.some((id) => id.startsWith('ofr_harbour-ledger_'))).toBe(false);
    expect(after.filter((id) => id.startsWith('ofr_quayside-gazette_'))).toEqual(
      before.filter((id) => id.startsWith('ofr_quayside-gazette_')),
    );
    expect(await statusOf(w.pubId['quayside-gazette'])).toBe('active');
  });

  it('writes one audit row with the operator, the target, the reason and the old and new status', async () => {
    const rows = await audits('publisher.suspended');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      target: w.pubId['harbour-ledger'],
      reason: 'Complaint under review',
      detail: { from: 'active', to: 'suspended' },
    });
  });

  it('ends open quotes on the suspended publisher offers and leaves other quotes alone', async () => {
    const quote = async (id: string, offer: string, exp: string) =>
      w.db.query(
        `INSERT INTO quotes (id, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, source, expires_at, created_at, updated_at)
         SELECT $1, NULL, o.id, o.version, 'keep_retrieve', 100, 'USD', 'us-usd', 'direct', $3, $4, $4
           FROM offers o WHERE o.id = $2 LIMIT 1`,
        [id, offer, exp, '2026-10-21T10:00:00.000Z'],
      );
    // Reactivate first so the next suspend has something to end.
    await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'active',
      reason: 'Cleared after review',
    });
    expect(await listed()).toContain('ofr_harbour-ledger_tide-tables');
    await quote('quo_h', 'ofr_harbour-ledger_tide-tables', '2099-01-01T00:00:00.000Z');
    await quote('quo_q', 'ofr_quayside-gazette_quay-walk', '2099-01-01T00:00:00.000Z');
    await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'suspended',
      reason: 'Second look needed',
    });
    const exp = async (id: string): Promise<number> =>
      Date.parse(
        String(
          (
            await w.db.query<{ e: unknown }>('SELECT expires_at AS e FROM quotes WHERE id = $1', [
              id,
            ])
          ).rows[0]!.e,
        ),
      );
    expect(await exp('quo_h')).toBeLessThanOrEqual(w.clock.now().getTime());
    expect(await exp('quo_q')).toBeGreaterThan(Date.parse('2098-01-01T00:00:00.000Z'));
  });

  it('reactivate restores the offers, with its own audit row', async () => {
    const r = await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'active',
      reason: 'Cleared again',
    });
    expect(r).toEqual({ ok: true, value: { status: 'active' } });
    expect(await listed()).toContain('ofr_harbour-ledger_tide-tables');
    expect((await audits('publisher.reactivated')).length).toBeGreaterThanOrEqual(1);
  });

  it('does not touch orders, units, entitlements or the ledger', async () => {
    const tables = ['orders', 'order_units', 'entitlements', 'ledger_entries', 'refund_requests'];
    const before = await Promise.all(
      tables.map((t) => count(w.db, `SELECT count(*) AS c FROM ${t}`)),
    );
    await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: w.pubId['northfield-quarterly'],
      status: 'suspended',
      reason: 'Check of the tables',
    });
    const after = await Promise.all(
      tables.map((t) => count(w.db, `SELECT count(*) AS c FROM ${t}`)),
    );
    expect(after).toEqual(before);
  });

  it('refuses a change to the status it already has, and an applicant, writing nothing', async () => {
    const audit0 = await count(w.db, 'SELECT count(*) AS c FROM audit_log');
    expect(
      await setPublisherStatus(w.deps(), w.operator, {
        publisher_id: w.pubId['northfield-quarterly'],
        status: 'suspended',
        reason: 'Again',
      }),
    ).toEqual({ ok: false, error: { code: 'unchanged' } });
    await w.db.query("UPDATE publishers SET status = 'applied' WHERE id = $1", [
      w.pubId['quayside-gazette'],
    ]);
    expect(
      await setPublisherStatus(w.deps(), w.operator, {
        publisher_id: w.pubId['quayside-gazette'],
        status: 'active',
        reason: 'Approve applicant',
      }),
    ).toEqual({ ok: false, error: { code: 'not_allowed' } });
    expect(await statusOf(w.pubId['quayside-gazette'])).toBe('applied');
    expect(await count(w.db, 'SELECT count(*) AS c FROM audit_log')).toBe(audit0);
  });

  it('refuses an unknown publisher and a bad reason', async () => {
    expect(
      await setPublisherStatus(w.deps(), w.operator, {
        publisher_id: 'pub_nobody',
        status: 'suspended',
        reason: 'Why not',
      }),
    ).toEqual({ ok: false, error: { code: 'not_found' } });
    for (const reason of ['', 'ab', '  x ', 'y'.repeat(201)]) {
      expect(
        await setPublisherStatus(w.deps(), w.operator, {
          publisher_id: w.pubId['northfield-quarterly'],
          status: 'active',
          reason,
        }),
      ).toEqual({ ok: false, error: { code: 'invalid_input' } });
    }
  });

  it('refuses every actor but an operator with the second factor', async () => {
    const input = {
      publisher_id: w.pubId['northfield-quarterly'],
      status: 'active' as const,
      reason: 'Should not work',
    };
    expect(await setPublisherStatus(w.deps(), w.harbour, input)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await setPublisherStatus(w.deps(), w.buyer, input)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await setPublisherStatus(w.deps(), w.system, input)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(
      await setPublisherStatus(
        w.deps(),
        { kind: 'operator', operator_id: 'opr_demo', mfa: false },
        input,
      ),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(await statusOf(w.pubId['northfield-quarterly'])).toBe('suspended');
  });
});
