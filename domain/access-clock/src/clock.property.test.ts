// Property: the materialised access_windows row equals computeWindow of the log after every
// operation, over 2000 random operation sequences against a real (PGlite) database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeWindow,
  grantCredit,
  markAccessReady,
  recordDeliveryEvent,
  revokeWindow,
  sweepWindows,
} from './index';
import { HASH, makeWorld, policyFor } from './world';
import type { World } from './world';

const H = 3_600_000;
let w: World;
beforeAll(async () => {
  w = await makeWorld('prop');
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

describe('materialised equals recomputed', () => {
  it('materialised equals recomputed (2,000 random sequences)', { timeout: 600_000 }, async () => {
    const next = rng(424242);
    const START = w.clock.now().getTime();
    for (let i = 0; i < 2000; i++) {
      w.clock.set(new Date(START).toISOString());
      const id = await w.rawEntitlement(i + 1);
      const steps = 1 + Math.floor(next() * 6);
      for (let s = 0; s < steps; s++) {
        w.clock.advance(Math.floor(next() * 3 * 24 * H));
        const pick = Math.floor(next() * 8);
        if (pick === 0) {
          await w.db.transaction((tx) =>
            markAccessReady(tx, w.deps, {
              entitlement_id: id,
              evidence: { capture_id: 'C', content_sha256: HASH, link_probe: 'ok' },
            }),
          );
        } else if (pick === 1) {
          await recordDeliveryEvent(w.deps, {
            entitlement_id: id,
            kind: 'delivery_failed',
            link_id: null,
            source: next() < 0.2 ? 'buyer' : 'system',
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
          await recordDeliveryEvent(w.deps, {
            entitlement_id: id,
            kind: next() < 0.5 ? 'reader_beacon' : 'reader_rendered',
            link_id: null,
            source: next() < 0.5 ? 'buyer' : 'system',
            evidence: {},
          });
        } else if (pick === 4) {
          await w.db.transaction((tx) =>
            grantCredit(tx, w.deps, {
              entitlement_id: id,
              credit_ms: 1 + Math.floor(next() * 10 * H),
              case_id: 'c',
              by: { kind: 'system' },
            }),
          );
        } else if (pick === 5) {
          await sweepWindows(w.deps, { max_items: 5 });
        } else if (pick === 6 && next() < 0.3) {
          await w.db.transaction((tx) =>
            revokeWindow(tx, w.deps, { entitlement_id: id, reason: 'refund' }),
          );
        } else {
          await recordDeliveryEvent(w.deps, {
            entitlement_id: id,
            kind: 'download_completed',
            link_id: null,
            source: 'system',
            evidence: {},
          });
        }
        const rows = await w.db.query<{
          kind: string;
          at: Date;
          source: 'system' | 'buyer' | 'operator';
          evidence: Record<string, string | number | boolean | null>;
        }>(
          'SELECT kind, at, source, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, ctid',
          [id],
        );
        const events = rows.rows.map((r) => ({
          entitlement_id: id,
          kind: r.kind as never,
          at: r.at.toISOString(),
          source: r.source,
          evidence: r.evidence,
        }));
        // The row is rewritten whenever an event is recorded, so it equals the recomputation at its own
        // last write time (updated_at); a call that records nothing leaves it as it was.
        const got = (
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
        const expected = computeWindow(events, policyFor('keep_retrieve'), got.updated_at);
        const iso = (d: Date | null) => d?.toISOString() ?? null;
        expect(
          {
            state: got.state,
            started_at: iso(got.started_at),
            base_ends_at: iso(got.base_ends_at),
            ends_at: iso(got.ends_at),
            paused_at: iso(got.paused_at),
            credit_ms: got.credit_ms,
          },
          `sequence ${i} step ${s}`,
        ).toEqual(expected);
        const acc = (
          await w.db.query<{ access_state: string; money_state: string }>(
            'SELECT access_state, money_state FROM entitlements WHERE id = $1',
            [id],
          )
        ).rows[0]!;
        if (acc.access_state === 'available') expect(acc.money_state).toBe('captured');
      }
    }
  });
});
