// CO-5 (ASM-59) property: over 1,000 random sequences of delivery_failed, delivery_restored,
// credit_granted, partial refunds and full refunds against a real (PGlite) database:
//   - ends_at never decreases before a revoke;
//   - nothing changes after a revoke (window row and access state);
//   - `available` never follows a full refund;
//   - no credit_granted is written after the revoked event;
//   - the materialised window equals computeWindow(events) after every event.
// A partial refund writes nothing to the access clock (the entitlement table maps it to a no-op),
// so that step asserts the window row and the log are untouched. A full refund does what
// applyMoneyEvent does to the row, then calls revokeWindow, the only revoke path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeWindow,
  grantCredit,
  markAccessReady,
  recordDeliveryEvent,
  revokeWindow,
} from './index';
import { HASH, makeWorld, policyFor, START } from './world';
import type { World } from './world';

const H = 3_600_000;
let w: World;
beforeAll(async () => {
  w = await makeWorld('rfp');
});
afterAll(async () => {
  await w.close();
});

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Snap {
  state: string;
  started_at: string | null;
  base_ends_at: string | null;
  ends_at: string | null;
  paused_at: string | null;
  credit_ms: number;
}
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('refund and credit interplay, random sequences', () => {
  it('holds the five invariants over 1,000 sequences', { timeout: 900_000 }, async () => {
    const next = rng(5050505);
    const evidence = { capture_id: 'C', content_sha256: HASH, link_probe: 'ok' as const };
    const snap = async (id: string): Promise<Snap & { updated_at: Date }> => {
      const r = (
        await w.db.query<{
          state: string;
          started_at: Date | null;
          base_ends_at: Date | null;
          ends_at: Date | null;
          paused_at: Date | null;
          credit_ms: number;
          updated_at: Date;
        }>(
          'SELECT state, started_at, base_ends_at, ends_at, paused_at, credit_ms, updated_at FROM access_windows WHERE entitlement_id = $1',
          [id],
        )
      ).rows[0]!;
      return {
        state: r.state,
        started_at: iso(r.started_at),
        base_ends_at: iso(r.base_ends_at),
        ends_at: iso(r.ends_at),
        paused_at: iso(r.paused_at),
        credit_ms: r.credit_ms,
        updated_at: r.updated_at,
      };
    };
    const plain = (r: Snap & { updated_at: Date }): Snap => ({
      state: r.state,
      started_at: r.started_at,
      base_ends_at: r.base_ends_at,
      ends_at: r.ends_at,
      paused_at: r.paused_at,
      credit_ms: r.credit_ms,
    });

    for (let i = 0; i < 1000; i++) {
      w.clock.set(START);
      const id = await w.rawEntitlement(i + 1);
      const steps = 2 + Math.floor(next() * 7);
      let prevEnds: number | null = null;
      let frozen: Snap | null = null;
      let refunded = false;
      for (let s = 0; s < steps; s++) {
        w.clock.advance(Math.floor(next() * 2 * 24 * H));
        const before = plain(await snap(id));
        const eventsBefore = (
          await w.db.query('SELECT 1 FROM access_events WHERE entitlement_id = $1', [id])
        ).rows.length;
        const pick = Math.floor(next() * 7);
        let partial = false;
        if (pick === 0 || s === 0) {
          try {
            await w.db.transaction((tx) =>
              markAccessReady(tx, w.deps, { entitlement_id: id, evidence }),
            );
          } catch {
            // refused after a full refund: money is not captured
            expect(refunded).toBe(true);
          }
        } else if (pick === 1) {
          await recordDeliveryEvent(w.deps, {
            entitlement_id: id,
            kind: 'delivery_failed',
            link_id: null,
            source: 'system',
            evidence: {},
          });
        } else if (pick === 2) {
          await recordDeliveryEvent(w.deps, {
            entitlement_id: id,
            kind: 'delivery_restored',
            link_id: null,
            source: 'system',
            evidence: {},
          });
        } else if (pick === 3) {
          await w.db.transaction((tx) =>
            grantCredit(tx, w.deps, {
              entitlement_id: id,
              credit_ms: 1 + Math.floor(next() * 10 * H),
              case_id: 'c',
              by: { kind: 'system' },
            }),
          );
        } else if (pick === 4) {
          partial = true; // a partial refund: no access-clock call at all
        } else if (pick === 5 && next() < 0.5) {
          await w.db.query(
            `UPDATE entitlements SET money_state = 'refunded', access_state = 'revoked', licence_state = 'terminated' WHERE id = $1`,
            [id],
          );
          await w.db.transaction((tx) =>
            revokeWindow(tx, w.deps, { entitlement_id: id, reason: 'refund' }),
          );
          refunded = true;
        } else {
          await recordDeliveryEvent(w.deps, {
            entitlement_id: id,
            kind: 'download_completed',
            link_id: null,
            source: 'system',
            evidence: {},
          });
        }
        const label = `sequence ${i} step ${s}`;
        const raw = await snap(id);
        const after = plain(raw);

        // A partial refund moves nothing.
        if (partial) {
          expect(after, label).toEqual(before);
          const n = (
            await w.db.query('SELECT 1 FROM access_events WHERE entitlement_id = $1', [id])
          ).rows.length;
          expect(n, label).toBe(eventsBefore);
        }
        // Materialised equals recomputed (the row is rewritten at its own updated_at).
        const log = (
          await w.db.query<{
            kind: string;
            at: Date;
            source: 'system' | 'buyer' | 'operator';
            evidence: Record<string, string | number | boolean | null>;
          }>(
            'SELECT kind, at, source, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
            [id],
          )
        ).rows;
        const expected = computeWindow(
          log.map((r) => ({
            entitlement_id: id,
            kind: r.kind as never,
            at: r.at.toISOString(),
            source: r.source,
            evidence: r.evidence,
          })),
          policyFor('keep_retrieve'),
          raw.updated_at,
        );
        expect(after, label).toEqual(expected);

        // ends_at never decreases before a revoke; nothing changes after one.
        if (frozen !== null) {
          expect(after, `${label} (after revoke)`).toEqual(frozen);
        } else if (after.ends_at !== null) {
          const cur = Date.parse(after.ends_at);
          if (prevEnds !== null) expect(cur, label).toBeGreaterThanOrEqual(prevEnds);
          prevEnds = cur;
        }
        if (after.state === 'revoked') frozen ??= after;

        // available never follows a full refund; no credit after the revoke.
        const acc = (
          await w.db.query<{ access_state: string; money_state: string }>(
            'SELECT access_state, money_state FROM entitlements WHERE id = $1',
            [id],
          )
        ).rows[0]!;
        if (refunded) expect(acc.access_state, label).not.toBe('available');
        if (acc.access_state === 'available') expect(acc.money_state, label).toBe('captured');
        const kinds = log.map((r) => r.kind);
        const cut = kinds.indexOf('revoked');
        if (cut >= 0) expect(kinds.slice(cut + 1), label).not.toContain('credit_granted');
      }
    }
  });
});
