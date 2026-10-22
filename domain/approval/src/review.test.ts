// Opus review 3: L5, L6, L7, L10 for approval.
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalSnapshot, Result } from '@umsbx/contracts';
import {
  canonicalJson,
  contentHash,
  makeToken,
  markUsed,
  requestApproval,
  verifyApproval,
} from './index';
import { BUYER_A, BUYER_B, CONSENT, addQuote, makeHarness, type Harness } from './test-fixtures';

let h: Harness;
let opened = false;
afterEach(async () => {
  if (opened) await h.db.close();
  opened = false;
});
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
async function granted() {
  h = await makeHarness();
  opened = true;
  await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
  return value(
    await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: { kind: 'quote', quote_id: 'quo_1' },
      consent: CONSENT,
    }),
  );
}
const verify = (
  g: { approval_id: string; token: string },
  actor: Parameters<typeof verifyApproval>[2]['actor'] = BUYER_A,
) => verifyApproval(h.db, h.deps, { approval_id: g.approval_id, token: g.token, actor });

describe('L6 check order: token, then owner, then expiry, then used', () => {
  it('another buyer with a valid token learns nothing about expiry', async () => {
    const g = await granted();
    h.clock.advance(15 * 60_000);
    expect(await verify(g, BUYER_B)).toEqual({
      ok: false,
      error: { code: 'not_owner', http: 404 },
    });
    expect(await verify(g, BUYER_A)).toEqual({ ok: false, error: { code: 'expired', http: 410 } });
  });

  it('another buyer with a valid token learns nothing about use', async () => {
    const g = await granted();
    await markUsed(h.db, h.deps, { approval_id: g.approval_id });
    expect(await verify(g, BUYER_B)).toEqual({
      ok: false,
      error: { code: 'not_owner', http: 404 },
    });
    expect(await verify(g, BUYER_A)).toEqual({
      ok: false,
      error: { code: 'already_used', http: 409 },
    });
  });

  it('non-buyer actors get not_owner even when expired and used', async () => {
    const g = await granted();
    await markUsed(h.db, h.deps, { approval_id: g.approval_id });
    h.clock.advance(15 * 60_000);
    expect(await verify(g, { kind: 'system' })).toEqual({
      ok: false,
      error: { code: 'not_owner', http: 404 },
    });
  });

  it('a wrong token still answers bad_token before the owner check', async () => {
    const g = await granted();
    expect(await verify({ ...g, token: `${g.approval_id}.${'0'.repeat(64)}` }, BUYER_B)).toEqual({
      ok: false,
      error: { code: 'bad_token', http: 403 },
    });
  });
});

describe('L5 snapshot reader must be the row buyer', () => {
  it('a row whose buyer_id differs from snapshot.reader.buyer_id is snapshot_tampered', async () => {
    const g = await granted();
    // The database guard bars rewriting an approval, so a forged row is inserted: owned by buy_B,
    // snapshot reader buy_A, hash and token valid. Only the reader check can catch it.
    const nonce = 'f'.repeat(32);
    const expires_at = '2026-10-22T10:15:00.000Z';
    const id = 'apr_forged';
    await h.db.query(
      `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
       VALUES ($1, 'buy_B', $2::jsonb, $3, $4, $5, NULL, $6, $7, $7)`,
      [
        id,
        JSON.stringify(g.snapshot),
        g.content_hash,
        nonce,
        expires_at,
        'dryrun',
        '2026-10-22T10:00:00.000Z',
      ],
    );
    const token = makeToken(h.deps.config.approval_secret.reveal(), {
      approval_id: id,
      nonce,
      content_hash: g.content_hash,
      expires_at,
    });
    expect(g.snapshot.reader.buyer_id).toBe('buy_A');
    // The reader check comes with the hash check, before the owner check, for every actor.
    for (const actor of [BUYER_A, BUYER_B]) {
      expect(await verify({ approval_id: id, token }, actor)).toEqual({
        ok: false,
        error: { code: 'snapshot_tampered', http: 403 },
      });
    }
  });
});

describe('L7 canonicalJson is injective at _minor keys', () => {
  it('a string at a _minor key is refused (405 and "4.05" must not collide)', () => {
    expect(() => canonicalJson({ amount_minor: '4.05' }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ amount_minor: true }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ amount_minor: { a: 1 } }, 2)).toThrow(TypeError);
  });
  it('non-integers at _minor keys are refused', () => {
    expect(() => canonicalJson({ amount_minor: 4.5 }, 2)).toThrow(TypeError);
    expect(() => canonicalJson({ amount_minor: [4.5] }, 2)).toThrow(TypeError);
  });
  it('arrays under a _minor key are formatted element by element', () => {
    expect(canonicalJson({ prices_minor: [405, 5] }, 2)).toBe('{"prices_minor":["4.05","0.05"]}');
    expect(() => canonicalJson({ prices_minor: ['4.05'] }, 2)).toThrow(TypeError);
    expect(canonicalJson({ prices_minor: [] }, 2)).toBe('{"prices_minor":[]}');
  });
  it('null at a _minor key stays null', () => {
    expect(canonicalJson({ floor_minor: null }, 2)).toBe('{"floor_minor":null}');
  });
  it('a nested object under an array under _minor keeps its own key rules', () => {
    expect(() => canonicalJson({ xs_minor: [{ a_minor: '1' }] }, 2)).toThrow(TypeError);
  });
  it('strings and keys are NFC-normalised: composed and decomposed forms hash alike', () => {
    const composed = 'é';
    const decomposed = 'é';
    expect(canonicalJson({ k: composed }, 2)).toBe(canonicalJson({ k: decomposed }, 2));
    expect(canonicalJson({ [composed]: 1 }, 2)).toBe(canonicalJson({ [decomposed]: 1 }, 2));
  });
  it('two keys that normalise to the same text are refused', () => {
    expect(() => canonicalJson({ ['é']: 1, ['é']: 2 }, 2)).toThrow(TypeError);
  });
});

describe('L10 golden vectors', () => {
  const snapshot: ApprovalSnapshot = {
    snapshot_version: '1',
    items: [
      {
        article_id: 'art_1',
        article_sha256: 'a'.repeat(64),
        offer_id: 'ofr_1',
        offer_version: '1',
        terms_version: 'terms-1',
        publisher_id: 'pub_1',
        payee_merchant_id: 'MERCH1',
        option: 'keep_retrieve',
        policy: {
          id: 'keep_retrieve',
          version: '1',
          option: 'keep_retrieve',
          window_ms: 432_000_000,
          start_rule: 'payment_verified_and_delivery_ready',
        },
        rights: { scope: 'personal_use', ai_scope: 'review', redistribution: false },
        amount_minor: 405,
      },
    ],
    publishers: [
      {
        publisher_id: 'pub_1',
        payee_merchant_id: 'MERCH1',
        amount_minor: 405,
        platform_fee_minor: 0,
      },
    ],
    total_minor: 405,
    currency: 'USD',
    corridor_id: 'us-usd',
    reader: { buyer_id: 'buy_A' },
    rule_version: 'rules-1',
    pricing_rule_version: 'pricing-1',
  };
  it('contentHash of a fixed snapshot is a fixed value', () => {
    expect(contentHash(snapshot)).toBe(
      'a20c9cd463fe92bbc18be98777da4764a57058d17a337e473ee14537c381ce8a',
    );
  });
});
