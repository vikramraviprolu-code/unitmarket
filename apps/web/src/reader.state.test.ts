// READER-A (docs/specs/reader-a-view.md): the in-app reader. A bought article is read on the server
// through the same issueLink and planServe the content route uses, so the delivery evidence is the
// evidence of one /c/[token] read, and every refusal is the content route's reason. The page is a .tsx
// file the unit runner does not compile, so its source is read; the engine method and the pure
// paragraph splitter are driven for real over the offline dry-run app.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call } from './support';
import { bootRefundWorld, buy, postRefund } from './refund-support';
import type { RefundWorld } from './refund-support';
import { MAX_READER_BYTES, splitParagraphs } from './lib/reader-view';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
beforeAll(async () => {
  w = await bootRefundWorld();
});
afterAll(async () => {
  await w.app.close();
});

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

interface EventRow {
  kind: string;
  source: string;
  environment: string;
  evidence: Record<string, unknown>;
}
const eventsOf = async (entitlement_id: string): Promise<EventRow[]> =>
  (
    await w.app.db.query<EventRow>(
      `SELECT kind, source, environment, evidence FROM access_events
        WHERE entitlement_id = $1 ORDER BY at, id`,
      [entitlement_id],
    )
  ).rows;

/** The events of a read with the per-link values (link id, expiry) taken out, so two reads compare. */
const shape = (rows: EventRow[]): unknown[] =>
  rows.map((r) => {
    const { expires_at: _e, ...rest } = r.evidence;
    return { kind: r.kind, source: r.source, environment: r.environment, evidence: rest };
  });

const storedText = async (entitlement_id: string): Promise<string> => {
  const r = await w.app.db.query<{ data: Uint8Array }>(
    `SELECT c.data FROM entitlements e JOIN articles a ON a.id = e.article_id
       JOIN content_blobs c ON c.content_key = a.content_key WHERE e.id = $1`,
    [entitlement_id],
  );
  return new TextDecoder().decode(new Uint8Array(r.rows[0]!.data));
};

describe('the paragraph splitter', () => {
  it('splits on blank lines, trims, drops empty paragraphs and keeps markup as text', () => {
    expect(splitParagraphs('One\nstill one\n\n\nTwo  \r\n\r\n   \n<b>Three</b>\n')).toEqual([
      'One\nstill one',
      'Two',
      '<b>Three</b>',
    ]);
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('\n\n \n')).toEqual([]);
  });

  it('caps the size at 200 KB', () => {
    expect(MAX_READER_BYTES).toBe(200 * 1024);
  });
});

describe('the reader view of a ready entitlement', () => {
  it('returns the article as paragraphs with the title, publisher, option, window and label', async () => {
    const u = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorA });
    expect(v.ok).toBe(true);
    if (!v.ok || v.kind !== 'text') throw new Error('expected a text view');
    const item = (await w.app.engine.libraryItem({
      entitlement_id: u.entitlement_id,
      actor: w.actorA,
    }))!;
    expect(v.title).toBe(item.title);
    expect(v.publisher).toBe(item.publisher);
    expect(v.option).toBe('online_read');
    expect(v.environment).toBe('dryrun');
    expect(v.window.state).toBe('running');
    expect(v.window.ends_at).toBe(item.window.ends_at);
    expect(v.paragraphs.length).toBeGreaterThan(0);
    expect(v.paragraphs).toEqual(splitParagraphs(await storedText(u.entitlement_id)));
  });

  it('writes the evidence of one /c/[token] read: link_issued, then reader_rendered with bytes and hash', async () => {
    const A = await buy(w, { offer: 'tide-tables', option: 'online_read' });
    const B = await buy(w, { offer: 'tide-tables', option: 'online_read', who: 'B' });
    expect(A.entitlement_id).not.toBe(B.entitlement_id);

    // A reads in the app.
    const rv = await w.app.engine.readerView({ entitlement_id: A.entitlement_id, actor: w.actorA });
    expect(rv.ok).toBe(true);

    // B reads through the content route: link, then GET /c/[token]?mode=read to the end.
    const link = await call(w.link.POST, {
      url: `/api/library/${B.entitlement_id}/link`,
      method: 'POST',
      body: {},
      session: w.B,
      params: { id: B.entitlement_id },
    });
    expect(link.status).toBe(200);
    const url = ((await link.json()) as { url: string }).url;
    const { GET } = await import('./app/c/[token]/route');
    const res = await call(GET, {
      url: `${url}?mode=read`,
      session: w.B,
      params: { token: url.slice('/c/'.length) },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    // The route finishes its evidence just after the last byte; wait for it.
    for (let i = 0; i < 50; i++) {
      if ((await eventsOf(B.entitlement_id)).some((e) => e.kind === 'reader_rendered')) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const fromReader = await eventsOf(A.entitlement_id);
    const fromRoute = await eventsOf(B.entitlement_id);
    expect(fromReader.map((e) => e.kind)).toEqual([
      'access_ready',
      'link_issued',
      'reader_rendered',
    ]);
    // Same offer, so the same bytes and the same hash: the two logs are equal apart from per-link values.
    expect(shape(fromReader)).toEqual(shape(fromRoute));
    const rendered = fromReader.find((e) => e.kind === 'reader_rendered')!;
    expect(rendered.source).toBe('system');
    expect(rendered.evidence).toMatchObject({ mode: 'read' });
    expect(typeof rendered.evidence['bytes']).toBe('number');
    expect(String(rendered.evidence['sha256'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts a use of the link, as the route does', async () => {
    const u = await buy(w, { offer: 'harbour-fees', option: 'online_read' });
    await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorA });
    const uses = await w.app.db.query<{ uses: number }>(
      'SELECT uses FROM links WHERE entitlement_id = $1',
      [u.entitlement_id],
    );
    expect(uses.rows.map((r) => Number(r.uses))).toEqual([1]);
  });
});

describe('refusals are the content route reasons', () => {
  it('another buyer sees not_found, and no event is written for the owner', async () => {
    const u = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
    const before = (await eventsOf(u.entitlement_id)).length;
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorB });
    expect(v).toEqual({ ok: false, code: 'not_found' });
    expect(await eventsOf(u.entitlement_id)).toHaveLength(before);
  });

  it('an unknown entitlement and a non-buyer see not_found', async () => {
    expect(await w.app.engine.readerView({ entitlement_id: 'ent_nope', actor: w.actorA })).toEqual({
      ok: false,
      code: 'not_found',
    });
    const u = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
    expect(
      await w.app.engine.readerView({
        entitlement_id: u.entitlement_id,
        actor: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
      }),
    ).toEqual({ ok: false, code: 'not_found' });
  });

  it('an ended window gives window_ended, the same code the link route gives', async () => {
    const u = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
    const past = new Date(w.app.security.clock.now().getTime() - 1000).toISOString();
    await w.app.db.query('UPDATE access_windows SET ends_at = $2 WHERE entitlement_id = $1', [
      u.entitlement_id,
      past,
    ]);
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorA });
    expect(v).toEqual({ ok: false, code: 'window_ended' });
    const route = await call(w.link.POST, {
      url: `/api/library/${u.entitlement_id}/link`,
      method: 'POST',
      body: {},
      session: w.A,
      params: { id: u.entitlement_id },
    });
    expect(route.status).toBe(403);
    expect(((await route.json()) as { error: { code: string } }).error.code).toBe('window_ended');
    expect((await eventsOf(u.entitlement_id)).map((e) => e.kind)).not.toContain('reader_rendered');
  });

  it('a refunded item gives the reason the link route gives and writes no reader_rendered', async () => {
    const u = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
    const refund = await postRefund(w, w.op, {
      unit_id: u.unit_id,
      amount_minor: u.amount_minor,
      reason: 'Reader refusal test',
    });
    expect(refund.status).toBe(200);
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorA });
    const viaLink = await w.app.engine.issueLink({
      entitlement_id: u.entitlement_id,
      actor: w.actorA,
    });
    expect(v.ok).toBe(false);
    expect(viaLink.ok).toBe(false);
    if (!v.ok && !viaLink.ok) expect(v.code).toBe(viaLink.error.code);
    expect((await eventsOf(u.entitlement_id)).map((e) => e.kind)).not.toContain('reader_rendered');
  });
});

describe('the reader page source', () => {
  const page = read('./app/library/[entitlement]/read/page.tsx');
  const code = page.replace(/\/\/.*$/gm, '');

  it('is buyer only: a non-buyer is sent to sign in with next', () => {
    expect(code).toMatch(/actor\?\.kind !== 'buyer'/);
    expect(code).toMatch(/redirect\(`\/signin\?next=\$\{encodeURIComponent\(/);
  });

  it('asks the engine, shows the meter, the label and one paragraph element per paragraph', () => {
    expect(code).toMatch(/engine\.readerView\(/);
    expect(code).toContain('<WindowMeter');
    expect(code).toContain('<EnvLabel environment={');
    expect(code).toMatch(/paragraphs\.map\(/);
    expect(code).toMatch(/<p key=\{[^}]+\}>\{[a-z]+\}<\/p>/);
    expect(code).toContain('notFound()');
  });

  it('puts article text in React text nodes only: no HTML injection, no inline style', () => {
    expect(code).not.toMatch(/dangerouslySetInnerHTML|innerHTML|style=|<script|<img|<iframe/);
    expect(code).not.toMatch(/Date\.now|new Date\(|Math\.random/);
  });

  it('the library item page links to it for online_read items and keeps the open button', () => {
    const item = read('./app/library/[entitlement]/page.tsx').replace(/\/\/.*$/gm, '');
    expect(item).toMatch(/option === 'online_read'/);
    expect(item).toMatch(/href=\{`\/library\/\$\{encodeURIComponent\(item\.entitlement_id\)\}\/read`\}/);
    expect(item).toContain('<OpenButton');
  });
});
