// CO-6: what an attacker who knows the passcode, or who sniffs a code, can and cannot do.
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Every call of timingSafeEqual in this test file's module graph is recorded and passed through.
const compared = vi.hoisted(() => ({ calls: [] as Array<[number, number]> }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls.push([a.byteLength, b.byteLength]);
      return real.timingSafeEqual(a, b);
    },
  };
});

import { withRoute, type RouteMeta } from './route';
import { SESSION_COOKIE, createSession, resolveSession } from './session';
import { acceptTotp, matchingSteps, operatorSignIn } from './totp';
import { ORIGIN, cookiePair, secret } from './test-support';
import {
  KEYS,
  MIN,
  SAKTHI_B32,
  STEP_MS,
  SAKTHI_KEY,
  VIKRAM_B32,
  VIKRAM_KEY,
  everythingWritten,
  totpRig,
  usedRows,
  type TotpRig,
} from './totp-test-support';

// The same shape as apps/web/src/app/api/session/route.ts: the passcode limiter, 5 per 15 min, per
// client address and persona.
const meta: RouteMeta = {
  path: '/api/session',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'passcode', per: 'ip', limit: 5, window_ms: 900_000 },
  rate_target: 'persona',
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};
const Input = z
  .object({
    persona: z.string(),
    operator: z.string().optional(),
    code: z.string().optional(),
  })
  .strict();

function signInRoute(r: TotpRig) {
  const run = withRoute(meta, Input, async ({ input }) => {
    const res = await operatorSignIn(r.deps, {
      keys: KEYS,
      operator: input.operator,
      code: input.code,
    });
    return res.ok
      ? { status: 200 as const, body: { mfa: res.mfa } }
      : { status: 401 as const, code: 'sign_in_failed', message: 'That did not work.' };
  })(r.deps);
  return (body: Record<string, string>, addr: string | undefined = '10.0.0.1') =>
    run(
      new Request(`${ORIGIN}/api/session`, {
        method: 'POST',
        headers: { origin: ORIGIN },
        body: JSON.stringify({ persona: 'operator', ...body }),
      }),
      addr === undefined ? {} : { remote_addr: addr },
    );
}
const wrong = (r: TotpRig, n: number): string => r.code(VIKRAM_KEY, 10 + n);

describe('wrong codes share the passcode limiter', () => {
  it('six wrong codes lock the persona bucket: the sixth attempt is 429, even with the right code', async () => {
    const r = await totpRig();
    const post = signInRoute(r);
    for (let n = 0; n < 5; n++)
      expect((await post({ operator: 'vikram', code: wrong(r, n) })).status).toBe(401);
    expect((await post({ operator: 'vikram', code: wrong(r, 5) })).status).toBe(429);
    expect((await post({ operator: 'vikram', code: r.code(VIKRAM_KEY) })).status).toBe(429);
    expect(await usedRows(r)).toEqual([]);
  });
  it('another client address has its own persona bucket, but the operator stays locked by the guesses', async () => {
    const r = await totpRig();
    const post = signInRoute(r);
    for (let n = 0; n < 6; n++) await post({ operator: 'vikram', code: wrong(r, n) });
    expect((await post({ operator: 'sakthi', code: r.code(SAKTHI_KEY) }, '10.0.0.2')).status).toBe(
      200,
    );
    expect((await post({ operator: 'vikram', code: r.code(VIKRAM_KEY) }, '10.0.0.3')).status).toBe(
      401,
    );
  });
});

describe('guessing codes while resetting the limiter with code-less sign-ins', () => {
  // A sign-in without a code succeeds (view and stop only) and resets the persona bucket. If that
  // were the only limiter, 4 guesses, 1 code-less sign-in, 4 guesses ... would never stop. The
  // per-operator failure bucket is reset only by a right code.
  for (const [label, addr] of [
    ['with a client address', '10.0.0.9'],
    ['with no client address (shared bucket)', undefined],
  ] as const) {
    it(`five wrong codes lock the operator for 15 min, ${label}`, async () => {
      const r = await totpRig();
      const post = signInRoute(r);
      let n = 0;
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < (round === 0 ? 4 : 1); i++)
          expect((await post({ operator: 'vikram', code: wrong(r, n++) }, addr)).status).toBe(401);
        // the code-less sign-in succeeds and gives the persona bucket its tokens back
        if (round === 0) expect((await post({ operator: 'vikram' }, addr)).status).toBe(200);
      }
      // five wrong codes for vikram so far: the right code is refused now
      expect((await post({ operator: 'vikram', code: r.code(VIKRAM_KEY) }, addr)).status).toBe(401);
      expect(await usedRows(r)).toEqual([]);
      // 15 minutes later the bucket has refilled
      r.clock.advance(15 * MIN);
      expect((await post({ operator: 'vikram', code: r.code(VIKRAM_KEY) }, addr)).status).toBe(200);
    });
  }
  it('the lock names the reason apart from a wrong code', async () => {
    const r = await totpRig();
    for (let n = 0; n < 5; n++)
      await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code: wrong(r, n) });
    expect(
      await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code: r.code(VIKRAM_KEY) }),
    ).toEqual({ ok: false, reason: 'locked' });
  });
  it('the lock is per operator: sakthi is not locked by guesses at vikram', async () => {
    const r = await totpRig();
    for (let n = 0; n < 6; n++)
      await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code: wrong(r, n) });
    expect(
      (await operatorSignIn(r.deps, { keys: KEYS, operator: 'sakthi', code: r.code(SAKTHI_KEY) }))
        .ok,
    ).toBe(true);
  });
  it('a right code gives the operator the tokens back', async () => {
    const r = await totpRig();
    for (let n = 0; n < 4; n++)
      await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code: wrong(r, n) });
    expect(
      (await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code: r.code(VIKRAM_KEY) }))
        .ok,
    ).toBe(true);
    r.clock.advance(STEP_MS);
    for (let n = 4; n < 8; n++)
      expect(
        await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code: wrong(r, n) }),
      ).toEqual({ ok: false, reason: 'wrong_code' });
  });
  it('names that are not operators spend no bucket: attacker strings cannot grow the table', async () => {
    const r = await totpRig();
    const before = await r.db.query('SELECT 1 FROM rate_buckets');
    for (let i = 0; i < 20; i++)
      await operatorSignIn(r.deps, {
        keys: KEYS,
        operator: `nobody${i}`,
        code: r.code(VIKRAM_KEY),
      });
    const after = await r.db.query('SELECT 1 FROM rate_buckets');
    expect(after.rows.length).toBe(before.rows.length);
  });
});
describe("a code is for one operator's key", () => {
  it("sakthi's code under vikram's name is refused, burns nothing, and still works for sakthi", async () => {
    const r = await totpRig();
    const sakthiCode = r.code(SAKTHI_KEY);
    expect(sakthiCode).not.toBe(r.code(VIKRAM_KEY));
    expect(
      await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code: sakthiCode }),
    ).toEqual({ ok: false, reason: 'wrong_code' });
    expect(await usedRows(r)).toEqual([]);
    expect(
      await operatorSignIn(r.deps, { keys: KEYS, operator: 'sakthi', code: sakthiCode }),
    ).toEqual({ ok: true, operator_id: 'opr_sakthi', mfa: true });
  });
  it("vikram's code under sakthi's name is refused", async () => {
    const r = await totpRig();
    expect(
      await operatorSignIn(r.deps, { keys: KEYS, operator: 'sakthi', code: r.code(VIKRAM_KEY) }),
    ).toEqual({ ok: false, reason: 'wrong_code' });
  });
  it.each([
    'opr_vikram',
    'vikram:x',
    'vikram,sakthi',
    '../vikram',
    'vikram\u0000',
    'vik',
    '',
    'demo',
  ])('the name %j does not select a key', async (operator) => {
    const r = await totpRig();
    const res = await operatorSignIn(r.deps, {
      keys: KEYS,
      operator,
      code: r.code(VIKRAM_KEY),
    });
    expect(res).toEqual({ ok: false, reason: 'unknown_operator' });
  });
});

describe('the comparison is constant time', () => {
  it('a right and a wrong code each go through timingSafeEqual, once per step of the window, on equal lengths', async () => {
    const r = await totpRig();
    const now = r.clock.now().getTime();
    for (const code of [r.code(VIKRAM_KEY), r.code(VIKRAM_KEY, -1), r.code(VIKRAM_KEY, 7)]) {
      compared.calls.length = 0;
      matchingSteps(VIKRAM_KEY, code, now);
      expect(compared.calls).toEqual([
        [6, 6],
        [6, 6],
        [6, 6],
      ]);
    }
  });
  it('the whole acceptance path does the same for a right, a wrong and a replayed code', async () => {
    const r = await totpRig();
    const key = { operator_id: 'opr_vikram', key: secret(VIKRAM_B32) } as const;
    const right = r.code(VIKRAM_KEY);
    const seen: number[] = [];
    for (const code of [right, r.code(VIKRAM_KEY, 7), right]) {
      compared.calls.length = 0;
      await acceptTotp(r.deps, { ...key, code });
      seen.push(compared.calls.length);
      expect(compared.calls.every(([a, b]) => a === 6 && b === 6)).toBe(true);
    }
    expect(seen).toEqual([3, 3, 3]);
  });
  it('a refused shape (not six digits) is the only early exit, and it needs no secret to decide', async () => {
    compared.calls.length = 0;
    expect(matchingSteps(VIKRAM_KEY, '12345', 0)).toEqual([]);
    expect(compared.calls).toEqual([]);
  });
});

describe('replay under concurrency', () => {
  it('two sign-ins with the same code at the same moment: exactly one is accepted', async () => {
    const r = await totpRig();
    const code = r.code(VIKRAM_KEY);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        acceptTotp(r.deps, { operator_id: 'opr_vikram', key: secret(VIKRAM_B32), code }),
      ),
    );
    expect(results.filter((x) => x === 'accepted')).toHaveLength(1);
    expect(results.filter((x) => x === 'replay')).toHaveLength(3);
    expect(await usedRows(r, 'opr_vikram')).toHaveLength(1);
  });
});

describe('hostile input', () => {
  it.each([
    '12345',
    '1234567',
    'abcdef',
    "123456'; DROP TABLE audit_log; --",
    '１２３４５６',
    '١٢٣٤٥٦',
    '\u0000'.repeat(6),
    'a'.repeat(100_000),
    '123456‮',
  ])('%j is a wrong code: no throw, no row, nothing used', async (code) => {
    const r = await totpRig();
    const res = await operatorSignIn(r.deps, { keys: KEYS, operator: 'vikram', code });
    expect(res.ok).toBe(false);
    expect(await usedRows(r)).toEqual([]);
  });
});

describe('the mfa flag lives in the signed cookie', () => {
  const op = { kind: 'operator', operator_id: 'opr_vikram', mfa: true } as const;
  it('a cookie with one changed character, or without its signature, is no session', async () => {
    const r = await totpRig();
    const c = cookiePair((await createSession(r.deps, op)).cookie);
    expect(await resolveSession(r.deps, c)).toEqual(op);
    expect(
      await resolveSession(
        r.deps,
        c.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')),
      ),
    ).toBeNull();
    expect(await resolveSession(r.deps, c.slice(0, c.indexOf('.')))).toBeNull();
  });
  it('the signature of a session without mfa does not give mfa, and the two are different signatures', async () => {
    const r = await totpRig();
    const plain = cookiePair((await createSession(r.deps, { ...op, mfa: false })).cookie);
    const strong = cookiePair((await createSession(r.deps, op)).cookie);
    expect(plain.split('.')[1]).not.toBe(strong.split('.')[1]);
    expect(await resolveSession(r.deps, plain)).toEqual({ ...op, mfa: false });
    // moving a plain signature onto another session's id gives nothing
    const id = (strong.split('=')[1] ?? '').split('.')[0];
    const grafted = `${SESSION_COOKIE}=${id}.${plain.split('.')[1]}`;
    expect(await resolveSession(r.deps, grafted)).toBeNull();
  });
  it('a cookie signed under another session secret is refused, mfa or not', async () => {
    const r = await totpRig();
    const other = { ...r.deps, session_secret: secret('another-session-secret-for-the-test') };
    const c = cookiePair((await createSession(other, op)).cookie);
    expect(await resolveSession(r.deps, c)).toBeNull();
  });
  it('the session secret is the root of trust: it alone can make the mfa signature (documented)', async () => {
    const r = await totpRig();
    const plain = cookiePair((await createSession(r.deps, { ...op, mfa: false })).cookie);
    const id = (plain.split('=')[1] ?? '').split('.')[0] ?? '';
    const forged = createHmac('sha256', r.deps.session_secret.reveal())
      .update(`session-mfa:${id}`)
      .digest('base64url');
    expect(await resolveSession(r.deps, `${SESSION_COOKIE}=${id}.${forged}`)).toEqual(op);
  });
  it('a buyer session never has an mfa field', async () => {
    const r = await totpRig();
    const buyer = { kind: 'buyer', buyer_id: 'buy_a' } as const;
    const c = cookiePair((await createSession(r.deps, buyer)).cookie);
    expect(await resolveSession(r.deps, c)).toEqual(buyer);
  });
});

describe('nothing written down holds a key or a code', () => {
  it('logs, audit rows, rate buckets and sessions after right, wrong, replayed, locked and unknown attempts', async () => {
    const r = await totpRig();
    const used: string[] = [];
    const tryIt = async (operator: string, code: string) => {
      used.push(code);
      return operatorSignIn(r.deps, { keys: KEYS, operator, code });
    };
    const good = r.code(VIKRAM_KEY);
    expect((await tryIt('vikram', good)).ok).toBe(true); // right
    await tryIt('vikram', good); // replay
    await tryIt('sakthi', r.code(VIKRAM_KEY, 1)); // another key's code
    await tryIt('nobody', r.code(SAKTHI_KEY)); // unknown name
    for (let n = 0; n < 6; n++) await tryIt('vikram', wrong(r, n)); // wrong, then locked
    await createSession(r.deps, { kind: 'operator', operator_id: 'opr_vikram', mfa: true });

    const text = await everythingWritten(r);
    // the run must really have logged refusals, or the check below proves nothing
    expect(r.log.events.some((e) => e.msg === 'operator_sign_in_refused')).toBe(true);
    for (const b32 of [VIKRAM_B32, SAKTHI_B32, VIKRAM_B32.toLowerCase(), SAKTHI_B32.toLowerCase()])
      expect(text).not.toContain(b32);
    for (const key of [VIKRAM_KEY, SAKTHI_KEY])
      for (const form of [key.toString('hex'), key.toString('base64'), key.toString('ascii')])
        expect(text).not.toContain(form);
    for (const code of new Set(used))
      expect(text).not.toMatch(new RegExp(`(?<![0-9])${code}(?![0-9])`));
    // the one audit row that exists says who and which step, nothing else
    const rows = await usedRows(r);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]?.detail ?? {}).sort()).toEqual(['actor_mfa', 'step']);
  });
});
