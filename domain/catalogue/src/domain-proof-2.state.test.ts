// DOMAIN-PROOF-2 (D-116, docs/specs/catalogue-domain-proof-2.md): one permanent code per publisher, the operator
// vouch, the removal of an address, and the "could not reach" answer at import start. Scripted web, no socket.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import {
  MAX_DOMAINS_PER_PUBLISHER,
  checkDomain,
  getProofCode,
  listDomains,
  listDomainsForOperator,
  removeDomain,
  requestDomain,
  vouchDomain,
} from './domain-proof';
import { runNextBatch, startVerifiedImport } from './import-stage';
import {
  SHOP,
  SHOP_HOST,
  SOURCE_URL,
  WELL_KNOWN_URL,
  auditRows,
  countOf,
  homeWithToken,
  importWorld,
  sha256Hex,
  shopPages,
} from './import-support';
import type { ImportWorld } from './import-support';

const fixture = (name: string): string =>
  readFileSync(new URL(`../test-data/${name}`, import.meta.url), 'utf8');
const worlds: ImportWorld[] = [];
const fresh = async (): Promise<ImportWorld> => {
  const w = await importWorld(shopPages(fixture));
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.db.close();
});

const CODE_RE = /^umv-[0-9a-f]{32}$/;
const OTHER = 'second.pub-one.invalid';
const OP_NO_MFA: Actor = { kind: 'operator', operator_id: 'opr_plain', mfa: false };
const sha = (s: string): Promise<string> => sha256Hex(new TextEncoder().encode(s));
const page = (w: ImportWorld, host: string, code: string): void => {
  w.web.pages[`https://${host}/`] = { body: homeWithToken(code, host) };
};
const rowOf = async (w: ImportWorld, host: string, publisher = w.pubId['harbour-ledger']) =>
  (
    await w.db.query<Record<string, unknown>>(
      'SELECT * FROM publisher_domains WHERE publisher_id = $1 AND host = $2',
      [publisher, host],
    )
  ).rows[0];
const asked = async (w: ImportWorld, actor: Actor, host: string): Promise<string> => {
  const r = await requestDomain(w.idep(), actor, { host });
  if (!r.ok || r.value.token === null) throw new Error('request refused in a helper');
  return r.value.token;
};

describe('A. one permanent code per publisher', () => {
  it('is made once, has the token shape, is the same on every call and is never shared', async () => {
    const w = await fresh();
    const a = await getProofCode(w.idep(), w.harbour);
    expect(a).toMatch(CODE_RE);
    expect(await getProofCode(w.idep(), w.harbour)).toBe(a);
    const b = await getProofCode(w.idep(), w.quayside);
    expect(b).toMatch(CODE_RE);
    expect(b).not.toBe(a);
    expect(await getProofCode(w.idep(), w.buyer)).toBeNull();
    expect(await getProofCode(w.idep(), w.operator)).toBeNull();
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM publisher_proof_codes')).toBe(2);
  });

  it('two new addresses get the same code, and one placement proves both', async () => {
    const w = await fresh();
    const t1 = await asked(w, w.harbour, SHOP_HOST);
    const t2 = await asked(w, w.harbour, OTHER);
    expect(t2).toBe(t1);
    expect(t1).toBe(await getProofCode(w.idep(), w.harbour));
    page(w, SHOP_HOST, t1);
    page(w, OTHER, t1);
    expect(await checkDomain(w.idep(), w.harbour, { host: SHOP_HOST })).toEqual({
      ok: true,
      value: { host: SHOP_HOST, state: 'verified' },
    });
    expect(await checkDomain(w.idep(), w.harbour, { host: OTHER })).toEqual({
      ok: true,
      value: { host: OTHER, state: 'verified' },
    });
    expect((await rowOf(w, OTHER))!['verified_by']).toBe('proof');
  });

  it('asking again for a pending address returns the same code (nothing to lose)', async () => {
    const w = await fresh();
    const a = await asked(w, w.harbour, SHOP_HOST);
    expect(await asked(w, w.harbour, SHOP_HOST)).toBe(a);
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM publisher_domains')).toBe(1);
  });

  it('the code is stored in clear, only the hash sits on the address row, and it is never audited or listed', async () => {
    const w = await fresh();
    const code = await asked(w, w.harbour, SHOP_HOST);
    const stored = await w.db.query<{ code: string }>(
      'SELECT code FROM publisher_proof_codes WHERE publisher_id = $1',
      [w.pubId['harbour-ledger']],
    );
    expect(stored.rows[0]!.code).toBe(code);
    expect((await rowOf(w, SHOP_HOST))!['token_hash']).toBe(await sha(code));
    expect(JSON.stringify(await rowOf(w, SHOP_HOST))).not.toContain(code);
    expect(JSON.stringify(await auditRows(w.db, '%'))).not.toContain(code);
    expect(JSON.stringify(await listDomains(w.db, w.harbour))).not.toContain(code);
    expect(JSON.stringify(await listDomainsForOperator(w.db, w.operator))).not.toContain(code);
  });

  it('old per-address tokens still prove (check) and still hold at import start', async () => {
    const w = await fresh();
    const old = 'umv-' + 'c'.repeat(32);
    await w.db.query(
      `INSERT INTO publisher_domains (id, publisher_id, host, token_hash, state, requested_at, verified_at, created_at, updated_at)
       VALUES ('pdm_old', $1, $2, $3, 'pending', $4, NULL, $4, $4)`,
      [w.pubId['harbour-ledger'], SHOP_HOST, await sha(old), '2026-11-01T00:00:00Z'],
    );
    page(w, SHOP_HOST, old);
    expect((await checkDomain(w.idep(), w.harbour, { host: SHOP_HOST })).ok).toBe(true);
    expect((await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL })).ok).toBe(
      true,
    );
  });

  it('the permanent code also proves a row that was made with an old random token', async () => {
    const w = await fresh();
    const old = 'umv-' + 'd'.repeat(32);
    await w.db.query(
      `INSERT INTO publisher_domains (id, publisher_id, host, token_hash, state, requested_at, verified_at, created_at, updated_at)
       VALUES ('pdm_old', $1, $2, $3, 'pending', $4, NULL, $4, $4)`,
      [w.pubId['harbour-ledger'], SHOP_HOST, await sha(old), '2026-11-01T00:00:00Z'],
    );
    const code = (await getProofCode(w.idep(), w.harbour))!;
    page(w, SHOP_HOST, code);
    expect((await checkDomain(w.idep(), w.harbour, { host: SHOP_HOST })).ok).toBe(true);
  });

  it('another publisher cannot claim a verified host, and its own code does not prove a host of the first', async () => {
    const w = await fresh();
    const code = await asked(w, w.harbour, SHOP_HOST);
    // the other publisher asks while the host is only pending: its code differs, the first one's page does not prove it
    const theirs = await asked(w, w.quayside, SHOP_HOST);
    expect(theirs).not.toBe(code);
    page(w, SHOP_HOST, code);
    expect(await checkDomain(w.idep(), w.quayside, { host: SHOP_HOST })).toEqual({
      ok: false,
      error: { code: 'proof_missing' },
    });
    expect((await checkDomain(w.idep(), w.harbour, { host: SHOP_HOST })).ok).toBe(true);
    // now verified for the first: a fresh request by the other is host_taken
    expect(await requestDomain(w.idep(), w.quayside, { host: SHOP_HOST })).toEqual({
      ok: false,
      error: { code: 'host_taken' },
    });
    expect(await checkDomain(w.idep(), w.quayside, { host: SHOP_HOST })).toMatchObject({
      ok: false,
    });
  });
});

describe('B. the operator vouch', () => {
  const pending = async (w: ImportWorld): Promise<string> => {
    await asked(w, w.harbour, SHOP_HOST);
    return (await rowOf(w, SHOP_HOST))!['id'] as string;
  };

  it('needs an operator, the second factor and a reason; a publisher, a buyer and a plain operator are refused', async () => {
    const w = await fresh();
    const id = await pending(w);
    const reason = 'Checked the owner on a call';
    for (const [actor, code] of [
      [w.harbour, 'not_operator'],
      [w.buyer, 'not_operator'],
      [OP_NO_MFA, 'mfa_required'],
    ] as const)
      expect(await vouchDomain(w.idep(), actor, { domain_id: id, reason })).toEqual({
        ok: false,
        error: { code },
      });
    for (const bad of ['', ' ', 'ab', 'x'.repeat(201)])
      expect(await vouchDomain(w.idep(), w.operator, { domain_id: id, reason: bad })).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
    expect((await rowOf(w, SHOP_HOST))!['state']).toBe('pending');
    expect(await auditRows(w.db, 'domain.vouched')).toHaveLength(0);
  });

  it('marks the row verified with who and why, and audits domain.vouched (no code in the row)', async () => {
    const w = await fresh();
    const id = await pending(w);
    const r = await vouchDomain(w.idep(), w.operator, {
      domain_id: id,
      reason: 'Checked the owner on a call',
    });
    expect(r).toEqual({ ok: true, value: { host: SHOP_HOST, state: 'verified' } });
    expect(await rowOf(w, SHOP_HOST)).toMatchObject({
      state: 'verified',
      verified_by: 'operator',
      vouched_by: 'opr_vikram',
      vouch_reason: 'Checked the owner on a call',
    });
    expect(await auditRows(w.db, 'domain.vouched')).toEqual([
      expect.objectContaining({
        action: 'domain.vouched',
        target: id,
        reason: 'Checked the owner on a call',
        actor_kind: 'operator',
        detail: expect.objectContaining({ host: SHOP_HOST }),
      }),
    ]);
    expect((await listDomains(w.db, w.harbour))![0]).toMatchObject({
      host: SHOP_HOST,
      state: 'verified',
      verified_by: 'operator',
    });
    expect(JSON.stringify(await listDomains(w.db, w.harbour))).not.toContain('Checked');
    expect(
      await vouchDomain(w.idep(), w.operator, { domain_id: id, reason: 'Again please' }),
    ).toEqual({
      ok: false,
      error: { code: 'unchanged' },
    });
    expect(
      await vouchDomain(w.idep(), w.operator, { domain_id: 'pdm_nope', reason: 'Not there' }),
    ).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('import start for a vouched row does not fetch the code, and the run still fetches the items', async () => {
    const w = await fresh();
    const id = await pending(w);
    expect(
      (await vouchDomain(w.idep(), w.operator, { domain_id: id, reason: 'Vouched by call' })).ok,
    ).toBe(true);
    // no code anywhere on the site
    w.web.pages[`${SHOP}/`] = { body: '<html><head></head><body>nothing</body></html>' };
    w.web.calls.length = 0;
    const b = await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    expect(b.ok).toBe(true);
    expect(w.web.calls).toEqual([]);
    expect(await runNextBatch(w.idep())).toBeTruthy();
    expect(w.web.calls.some((c) => c.url === SOURCE_URL)).toBe(true);
    expect(w.web.calls.some((c) => c.url === `${SHOP}/` || c.url === WELL_KNOWN_URL)).toBe(false);
  });

  it('the switch still applies to a vouched row: with it off, import start answers paused and fetches nothing', async () => {
    const w = await fresh();
    const id = await pending(w);
    await vouchDomain(w.idep(), w.operator, { domain_id: id, reason: 'Vouched by call' });
    w.may.on = false;
    expect(await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL })).toEqual({
      ok: false,
      error: { code: 'paused' },
    });
    w.may.on = true;
    w.may.throws = true;
    expect(await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL })).toEqual({
      ok: false,
      error: { code: 'paused' },
    });
    expect(w.web.calls).toEqual([]);
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM import_batches')).toBe(0);
  });

  it('cannot vouch a host that another publisher has verified (host_taken)', async () => {
    const w = await fresh();
    const code = await asked(w, w.harbour, SHOP_HOST);
    const theirs = await asked(w, w.quayside, SHOP_HOST);
    expect(theirs).not.toBe(code);
    page(w, SHOP_HOST, code);
    await checkDomain(w.idep(), w.harbour, { host: SHOP_HOST });
    const other = (await rowOf(w, SHOP_HOST, w.pubId['quayside-gazette']))!['id'] as string;
    expect(
      await vouchDomain(w.idep(), w.operator, { domain_id: other, reason: 'Trying it on' }),
    ).toEqual({
      ok: false,
      error: { code: 'host_taken' },
    });
  });

  it('the operator list shows address, state and who verified, with no code', async () => {
    const w = await fresh();
    const id = await pending(w);
    await asked(w, w.quayside, 'other.pub-two.invalid');
    const rows = (await listDomainsForOperator(w.db, w.operator))!;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === id)).toMatchObject({
      publisher_id: w.pubId['harbour-ledger'],
      host: SHOP_HOST,
      state: 'pending',
      verified_by: null,
    });
    expect(await listDomainsForOperator(w.db, w.harbour)).toBeNull();
    expect(await listDomainsForOperator(w.db, w.buyer)).toBeNull();
  });
});

describe('C. removing an address', () => {
  const verified = async (w: ImportWorld, host = SHOP_HOST): Promise<void> => {
    const code = await asked(w, w.harbour, host);
    page(w, host, code);
    expect((await checkDomain(w.idep(), w.harbour, { host })).ok).toBe(true);
  };

  it('the publisher removes its own address: soft state, audit, not listed, import refused', async () => {
    const w = await fresh();
    await verified(w);
    const id = (await rowOf(w, SHOP_HOST))!['id'] as string;
    expect(await removeDomain(w.idep(), w.harbour, { host: SHOP_HOST })).toEqual({
      ok: true,
      value: { host: SHOP_HOST, state: 'removed' },
    });
    expect((await rowOf(w, SHOP_HOST))!['state']).toBe('removed');
    expect(await listDomains(w.db, w.harbour)).toEqual([]);
    expect(await auditRows(w.db, 'domain.removed')).toEqual([
      expect.objectContaining({
        action: 'domain.removed',
        target: id,
        actor_kind: 'publisher',
        detail: expect.objectContaining({ host: SHOP_HOST }),
      }),
    ]);
    w.web.calls.length = 0;
    expect(await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL })).toEqual({
      ok: false,
      error: { code: 'domain_not_verified' },
    });
    expect(w.web.calls).toEqual([]);
    expect(await removeDomain(w.idep(), w.harbour, { host: SHOP_HOST })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('a removed address frees a slot of the 10', async () => {
    const w = await fresh();
    for (let i = 0; i < MAX_DOMAINS_PER_PUBLISHER; i += 1)
      await asked(w, w.harbour, `s${i}.pub-one.invalid`);
    expect(await requestDomain(w.idep(), w.harbour, { host: 'extra.pub-one.invalid' })).toEqual({
      ok: false,
      error: { code: 'too_many_domains' },
    });
    await removeDomain(w.idep(), w.harbour, { host: 's3.pub-one.invalid' });
    expect((await requestDomain(w.idep(), w.harbour, { host: 'extra.pub-one.invalid' })).ok).toBe(
      true,
    );
  });

  it('a removed verified address frees the host for another publisher', async () => {
    const w = await fresh();
    await verified(w);
    expect((await requestDomain(w.idep(), w.quayside, { host: SHOP_HOST })).ok).toBe(false);
    await removeDomain(w.idep(), w.harbour, { host: SHOP_HOST });
    const code = await asked(w, w.quayside, SHOP_HOST);
    page(w, SHOP_HOST, code);
    expect((await checkDomain(w.idep(), w.quayside, { host: SHOP_HOST })).ok).toBe(true);
  });

  it('asking again for a removed host makes it pending again (same row, new state)', async () => {
    const w = await fresh();
    await verified(w);
    await removeDomain(w.idep(), w.harbour, { host: SHOP_HOST });
    const again = await requestDomain(w.idep(), w.harbour, { host: SHOP_HOST });
    expect(again).toMatchObject({ ok: true, value: { state: 'pending' } });
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM publisher_domains')).toBe(1);
    expect(await rowOf(w, SHOP_HOST)).toMatchObject({ state: 'pending', verified_at: null });
  });

  it('only the owner removes by host; a stranger, a buyer and a plain operator cannot', async () => {
    const w = await fresh();
    await verified(w);
    expect(await removeDomain(w.idep(), w.quayside, { host: SHOP_HOST })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await removeDomain(w.idep(), w.buyer, { host: SHOP_HOST })).toEqual({
      ok: false,
      error: { code: 'not_publisher' },
    });
    const id = (await rowOf(w, SHOP_HOST))!['id'] as string;
    expect(
      await removeDomain(w.idep(), OP_NO_MFA, { domain_id: id, reason: 'Operator removal' }),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(await removeDomain(w.idep(), w.operator, { domain_id: id, reason: 'x' })).toEqual({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect((await rowOf(w, SHOP_HOST))!['state']).toBe('verified');
  });

  it('the operator removes by id with a reason and the audit row says who and why', async () => {
    const w = await fresh();
    await verified(w);
    const id = (await rowOf(w, SHOP_HOST))!['id'] as string;
    expect(
      await removeDomain(w.idep(), w.operator, { domain_id: id, reason: 'Site is gone' }),
    ).toEqual({ ok: true, value: { host: SHOP_HOST, state: 'removed' } });
    expect(await auditRows(w.db, 'domain.removed')).toEqual([
      expect.objectContaining({ actor_kind: 'operator', reason: 'Site is gone' }),
    ]);
  });

  it('removal is refused while an import from that address is queued or running', async () => {
    const w = await fresh();
    await verified(w);
    expect((await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL })).ok).toBe(
      true,
    );
    expect(await removeDomain(w.idep(), w.harbour, { host: SHOP_HOST })).toEqual({
      ok: false,
      error: { code: 'import_active' },
    });
  });

  it('published offers stay on sale: removal touches no article or offer', async () => {
    const w = await fresh();
    await verified(w);
    const before = [
      await countOf(w.db, 'SELECT count(*) AS c FROM offers'),
      await countOf(w.db, 'SELECT count(*) AS c FROM articles'),
      await countOf(w.db, "SELECT count(*) AS c FROM offers WHERE status = 'active'"),
    ];
    await removeDomain(w.idep(), w.harbour, { host: SHOP_HOST });
    expect([
      await countOf(w.db, 'SELECT count(*) AS c FROM offers'),
      await countOf(w.db, 'SELECT count(*) AS c FROM articles'),
      await countOf(w.db, "SELECT count(*) AS c FROM offers WHERE status = 'active'"),
    ]).toEqual(before);
  });
});

describe('D. unreachable site versus code missing at import start', () => {
  it.each(['dns_failed', 'timeout', 'network', 'bad_status', 'redirect', 'private_address'])(
    'a site that could not be read (%s) answers site_unreachable and audits the word',
    async (reason) => {
      const w = await fresh();
      const code = await asked(w, w.harbour, SHOP_HOST);
      page(w, SHOP_HOST, code);
      await checkDomain(w.idep(), w.harbour, { host: SHOP_HOST });
      w.web.pages[`${SHOP}/`] = { refuse: reason };
      w.web.pages[WELL_KNOWN_URL] = { refuse: reason };
      const b = await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
      expect(b).toEqual({ ok: false, error: { code: 'site_unreachable', detail: reason } });
      expect(await countOf(w.db, 'SELECT count(*) AS c FROM import_batches')).toBe(0);
      expect(await auditRows(w.db, 'import.proof_failed')).toHaveLength(1);
    },
  );

  it('a page that was read without the code still answers proof_lost', async () => {
    const w = await fresh();
    const code = await asked(w, w.harbour, SHOP_HOST);
    page(w, SHOP_HOST, code);
    await checkDomain(w.idep(), w.harbour, { host: SHOP_HOST });
    w.web.pages[`${SHOP}/`] = { body: '<html><head></head><body>no tag</body></html>' };
    w.web.pages[WELL_KNOWN_URL] = { refuse: 'bad_status' };
    expect(await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL })).toEqual({
      ok: false,
      error: { code: 'proof_lost' },
    });
  });
});
