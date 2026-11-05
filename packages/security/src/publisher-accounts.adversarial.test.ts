// POB-P1 adversarial, at the library: the invite code is the only secret a stranger can guess at, so a wrong,
// expired, reused or voided code all give one answer; a wrong code costs the same work as a right one (exactly
// one scrypt hash); ten tries from one address lock that address out; usernames show only after a right code;
// and no password or code reaches an audit row or a log line on any path.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Passcode from './passcode';

const hashes: string[] = [];
const verifies: Array<{ hash: string; attempt: string }> = [];
vi.mock('./passcode', async (importOriginal) => {
  const real = await importOriginal<typeof Passcode>();
  return {
    ...real,
    hashPasscode: (pw: string, salt: string) => {
      hashes.push(pw);
      return real.hashPasscode(pw, salt);
    },
    verifyPasscode: (hash: string, attempt: string) => {
      verifies.push({ hash, attempt });
      return real.verifyPasscode(hash, attempt);
    },
  };
});

const { ACCOUNT_DUMMY_HASH } = await import('./accounts');
const { PUBLISHER_CLAIM_RATE, claimPublisherAccount, hashInviteCode, verifyPublisherLogin } =
  await import('./publisher-accounts');
const { makeRig, seededIds } = await import('./test-support');
type Rig = Awaited<ReturnType<typeof makeRig>>;

const PW = 'violet lamps hum softly';
const DAY = 86_400_000;
let n = 0;
beforeEach(() => {
  hashes.length = 0;
  verifies.length = 0;
});

async function world(
  o: { ttl?: number; used?: boolean; voided?: boolean; code?: string } = {},
): Promise<{ r: Rig; id: string; code: string }> {
  n += 1;
  const r = await makeRig({ ids: seededIds(`padv-${String(n)}`) });
  const id = `pub_adv${String(n)}`;
  const code = o.code ?? `ADVC${String(n).padStart(8, '0')}`;
  const at = r.clock.now().toISOString();
  await r.db.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'GB', 'active', $4, $4)`,
    [id, `adv-pub-${String(n)}`, `Adv Pub ${String(n)}`, at],
  );
  await r.db.query(
    `INSERT INTO publisher_invites (id, publisher_id, code_hash, expires_at, used_at, voided_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'opr_vikram', $7, $7)`,
    [
      `aud_adv${String(n)}`,
      id,
      hashInviteCode(code),
      new Date(r.clock.now().getTime() + (o.ttl ?? 7 * DAY)).toISOString(),
      o.used === true ? at : null,
      o.voided === true ? at : null,
      at,
    ],
  );
  return { r, id, code };
}
const claim = (r: Rig, code: string, username: string, ip_hash = 'ip-1', password = PW) =>
  claimPublisherAccount(r.deps, { code, username, password, ip_hash });
const accounts = async (r: Rig, id: string): Promise<number> =>
  (await r.db.query('SELECT 1 FROM publisher_accounts WHERE publisher_id = $1', [id])).rows.length;

describe('one answer for every bad code', () => {
  it('a wrong code, an expired one, a used one and a voided one are all invalid_code and create nothing', async () => {
    const wrong = await world();
    expect(await claim(wrong.r, 'ZZZZZZZZZZZZ', 'attacker.one')).toEqual({
      ok: false,
      code: 'invalid_code',
    });
    const expired = await world({ ttl: 1000 });
    expired.r.clock.advance(2000);
    expect(await claim(expired.r, expired.code, 'attacker.two')).toEqual({
      ok: false,
      code: 'invalid_code',
    });
    const used = await world({ used: true });
    expect(await claim(used.r, used.code, 'attacker.three')).toEqual({
      ok: false,
      code: 'invalid_code',
    });
    const voided = await world({ voided: true });
    expect(await claim(voided.r, voided.code, 'attacker.four')).toEqual({
      ok: false,
      code: 'invalid_code',
    });
    for (const x of [wrong, expired, used, voided]) expect(await accounts(x.r, x.id)).toBe(0);
  });

  it('the expiry is exact: valid just before, invalid at the second', async () => {
    const edge = await world({ ttl: 5000 });
    edge.r.clock.advance(4999);
    expect((await claim(edge.r, edge.code, 'edge.owner')).ok).toBe(true);
    const over = await world({ ttl: 5000 });
    over.r.clock.advance(5000);
    expect(await claim(over.r, over.code, 'edge.late')).toEqual({
      ok: false,
      code: 'invalid_code',
    });
  });

  it('a code voided by a newer invite stops working while the newer one works', async () => {
    const { r, id, code } = await world();
    await r.db.query('UPDATE publisher_invites SET voided_at = $2 WHERE publisher_id = $1', [
      id,
      r.clock.now().toISOString(),
    ]);
    await r.db.query(
      `INSERT INTO publisher_invites (id, publisher_id, code_hash, expires_at, used_at, voided_at, created_by, created_at, updated_at)
       VALUES ('aud_newer', $1, $2, $3, NULL, NULL, 'opr_vikram', $4, $4)`,
      [
        id,
        hashInviteCode('NEWERCDE2345'),
        new Date(r.clock.now().getTime() + DAY).toISOString(),
        r.clock.now().toISOString(),
      ],
    );
    expect(await claim(r, code, 'old.holder')).toEqual({ ok: false, code: 'invalid_code' });
    expect((await claim(r, 'NEWERCDE2345', 'new.holder')).ok).toBe(true);
  });

  it('a code cannot be used by two racing claims: one account results', async () => {
    const { r, id, code } = await world();
    const [a, b] = await Promise.all([
      claim(r, code, 'racer.one', 'ip-a'),
      claim(r, code, 'racer.two', 'ip-b'),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await accounts(r, id)).toBe(1);
  });
});

describe('equal work', () => {
  it('a wrong code, an expired one, a used one, a voided one and a right one each hash the password exactly once', async () => {
    const counts: Record<string, number> = {};
    const run = async (label: string, w: { r: Rig; code: string }, code = w.code, user = label) => {
      hashes.length = 0;
      await claim(w.r, code, `u.${user}`);
      counts[label] = hashes.length;
    };
    await run('wrong', await world(), 'ZZZZZZZZZZZZ');
    const e = await world({ ttl: 1000 });
    e.r.clock.advance(2000);
    await run('expired', e);
    await run('used', await world({ used: true }));
    await run('voided', await world({ voided: true }));
    await run('right', await world());
    expect(counts).toEqual({ wrong: 1, expired: 1, used: 1, voided: 1, right: 1 });
  });

  it('a taken username with a right code also hashes once', async () => {
    const a = await world();
    await claim(a.r, a.code, 'dup.name');
    const b = await world();
    // same database, same rig family: the second world has its own rig but the shared db holds the name
    hashes.length = 0;
    expect(await claim(b.r, b.code, 'dup.name')).toEqual({ ok: false, code: 'taken' });
    expect(hashes).toHaveLength(1);
  });

  it('sign in verifies exactly once for an unknown name, a wrong password and a locked account, with the dummy hash for the unknown', async () => {
    const { r, code } = await world();
    await claim(r, code, 'login.owner');
    verifies.length = 0;
    await verifyPublisherLogin(r.deps, {
      username: 'nobody.at.all',
      password: 'wrong wrong wrong',
    });
    const unknown = [...verifies];
    verifies.length = 0;
    await verifyPublisherLogin(r.deps, { username: 'login.owner', password: 'wrong wrong wrong' });
    const wrong = [...verifies];
    for (let i = 0; i < 19; i++)
      await verifyPublisherLogin(r.deps, {
        username: 'login.owner',
        password: 'wrong wrong wrong',
      });
    verifies.length = 0;
    await verifyPublisherLogin(r.deps, { username: 'login.owner', password: PW });
    const locked = [...verifies];
    verifies.length = 0;
    await verifyPublisherLogin(r.deps, { username: "x'; --", password: 'wrong wrong wrong' });
    const malformed = [...verifies];
    for (const c of [unknown, wrong, locked, malformed]) expect(c).toHaveLength(1);
    expect(unknown[0]!.hash).toBe(ACCOUNT_DUMMY_HASH);
    expect(malformed[0]!.hash).toBe(ACCOUNT_DUMMY_HASH);
    expect(wrong[0]!.hash).not.toBe(ACCOUNT_DUMMY_HASH);
  });

  it('a suspended publisher with the right password verifies once and answers like a wrong password', async () => {
    const { r, id, code } = await world();
    await claim(r, code, 'susp.owner');
    await r.db.query("UPDATE publishers SET status = 'suspended' WHERE id = $1", [id]);
    verifies.length = 0;
    expect(await verifyPublisherLogin(r.deps, { username: 'susp.owner', password: PW })).toEqual({
      ok: false,
    });
    expect(verifies).toHaveLength(1);
  });
});

describe('brute force', () => {
  it('ten tries from one address lock it out, even for the right code; another address is unaffected', async () => {
    const { r, id, code } = await world();
    for (let i = 0; i < PUBLISHER_CLAIM_RATE.limit; i++)
      expect(
        await claim(r, 'ZZZZZZZZZZZ' + String(i % 10), `guess.${String(i)}`, 'ip-evil'),
      ).toEqual({
        ok: false,
        code: 'invalid_code',
      });
    hashes.length = 0;
    expect(await claim(r, code, 'late.owner', 'ip-evil')).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    expect(hashes).toHaveLength(0); // refused before any scrypt work
    expect(await accounts(r, id)).toBe(0);
    expect((await claim(r, code, 'late.owner', 'ip-honest')).ok).toBe(true);
  });

  it('tries come back over time', async () => {
    const { r, code } = await world();
    for (let i = 0; i < PUBLISHER_CLAIM_RATE.limit; i++)
      await claim(r, 'ZZZZZZZZZZZZ', `g.${String(i)}`, 'ip-slow');
    expect(await claim(r, code, 'slow.owner', 'ip-slow')).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    r.clock.advance(PUBLISHER_CLAIM_RATE.window_ms);
    expect((await claim(r, code, 'slow.owner', 'ip-slow')).ok).toBe(true);
  });
});

describe('a username shows only after a right code', () => {
  it('a taken name with a wrong code looks like any other wrong code', async () => {
    const a = await world();
    await claim(a.r, a.code, 'known.name');
    const b = await world();
    expect(await claim(b.r, 'ZZZZZZZZZZZZ', 'known.name')).toEqual({
      ok: false,
      code: 'invalid_code',
    });
    expect(await claim(b.r, 'ZZZZZZZZZZZZ', 'fresh.name1')).toEqual({
      ok: false,
      code: 'invalid_code',
    });
  });
});

describe('secrets', () => {
  it('no password and no code reaches an audit row or a log on any path', async () => {
    const { r, code } = await world();
    await claim(r, 'ZZZZZZZZZZZZ', 'leak.test');
    await claim(r, code, 'leak.owner');
    await verifyPublisherLogin(r.deps, { username: 'leak.owner', password: 'wrong wrong wrong' });
    await verifyPublisherLogin(r.deps, { username: 'leak.owner', password: PW });
    const text = JSON.stringify([r.audit, r.log.events]);
    for (const secret of [PW, 'wrong wrong wrong', code, 'ZZZZZZZZZZZZ', hashInviteCode(code)])
      expect(text, secret).not.toContain(secret);
  });
});
