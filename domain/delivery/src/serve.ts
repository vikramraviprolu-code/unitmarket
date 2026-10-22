// Planning a content response. Pure of HTTP: the route streams `body` and calls onFinish or
// onAbort. "Sent" means the server finished sending, not that the device saved the file.
import { recordDeliveryEvent } from '@umsbx/access-clock';
import { err, ok } from '@umsbx/contracts';
import type { Actor, CoreDeps, ContentStore, Id, Result, Sha256Hex } from '@umsbx/contracts';
import { hashToken, readLinkToken } from './link-token';
import { gateEntitlement, loadArticle, safeHead } from './links';
import type { LinkError } from './links';

export interface ServePlan {
  status: 200;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  onFinish(sent: { bytes: number; sha256: Sha256Hex }): Promise<void>;
  onAbort(sent_bytes: number): Promise<void>;
}

const EXT: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/epub+zip': 'epub',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/** ASCII-only, no path or quote or CR/LF/semicolon characters; extension from the stored mime. */
export function sanitiseFilename(title: string, mime: string): string {
  const stem = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/_{2,}/g, '_')
    .replace(/^[\s._-]+|[\s._-]+$/g, '')
    .slice(0, 80)
    .replace(/[\s._-]+$/g, '');
  const ext = EXT[mime.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
  return `${stem.length > 0 ? stem : 'download'}.${ext}`;
}

type ServeError = LinkError | { code: 'bad_token' | 'expired' };

export async function planServe(
  d: CoreDeps & { content: ContentStore },
  i: { token: string; actor: Actor; mode: 'download' | 'read'; session_id?: Id },
): Promise<Result<ServePlan, ServeError>> {
  const read = readLinkToken(d.config.link_secret, i.token, d.clock.now());
  if (!read.ok) return err({ code: read.error });
  const row = (
    await d.db.query<{
      entitlement_id: Id;
      buyer_id: Id;
      token_hash: string;
      session_id: Id | null;
    }>('SELECT entitlement_id, buyer_id, token_hash, session_id FROM links WHERE id = $1', [
      read.value.link_id,
    ])
  ).rows[0];
  if (row === undefined || row.token_hash !== hashToken(i.token)) {
    return err({ code: 'bad_token' });
  }
  // The token is bound to the buyer in the row, and to the session it was issued in when the row
  // names one: any other buyer or session sees a missing link (P13, A-20, architecture 9.6).
  if (i.actor.kind !== 'buyer' || i.actor.buyer_id !== row.buyer_id) {
    return err({ code: 'not_found' });
  }
  if (row.session_id !== null && row.session_id !== i.session_id) {
    return err({ code: 'not_found' });
  }
  const gate = await gateEntitlement(d, { entitlement_id: row.entitlement_id, actor: i.actor });
  if (!gate.ok) return gate;
  const view = gate.value;
  const link_id = read.value.link_id;

  const failed = (reason: string): Promise<unknown> =>
    recordDeliveryEvent(d, {
      entitlement_id: view.entitlement_id,
      kind: 'delivery_failed',
      link_id,
      source: 'system',
      evidence: { reason },
    });

  const article = await loadArticle(d, view.article_id);
  const head = article === null ? null : await safeHead(d.content, article.content_key);
  let stream: AsyncIterable<Uint8Array> | null = null;
  if (article !== null && head !== null) {
    try {
      stream = await d.content.open(article.content_key);
    } catch {
      stream = null;
    }
  }
  if (article === null || head === null || stream === null) {
    await failed('store_unavailable');
    return err({ code: 'store_unavailable' });
  }
  // Review 4 H2: the bytes must be the ones bought. The hash recorded when access became ready
  // (append-only evidence) and the article's catalogue hash both have to equal the head's hash.
  const expected = (
    await d.db.query<{ article_sha: string; ready_sha: string | null }>(
      `SELECT a.sha256 AS article_sha,
              (SELECT e.evidence ->> 'content_sha256' FROM access_events e
                WHERE e.entitlement_id = $2 AND e.kind = 'access_ready' LIMIT 1) AS ready_sha
         FROM articles a WHERE a.id = $1`,
      [view.article_id, view.entitlement_id],
    )
  ).rows[0];
  if (
    expected === undefined ||
    head.sha256 !== expected.article_sha ||
    (expected.ready_sha !== null && head.sha256 !== expected.ready_sha)
  ) {
    await failed('content_hash_mismatch');
    return err({ code: 'store_unavailable' });
  }
  const source = stream;
  await d.db.query('UPDATE links SET uses = uses + 1, updated_at = $2 WHERE id = $1', [
    link_id,
    d.clock.now().toISOString(),
  ]);

  const filename = sanitiseFilename(article.title, head.mime);
  const kind = i.mode === 'download' ? 'download_completed' : 'reader_rendered';
  return ok({
    status: 200,
    headers: {
      'Content-Type': head.mime,
      'Content-Length': String(head.bytes),
      'Content-Disposition': `${i.mode === 'download' ? 'attachment' : 'inline'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
    body: {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of source) yield chunk;
        } catch (e) {
          await failed('stream_error');
          throw e;
        }
      },
    },
    async onFinish(sent) {
      if (sent.sha256 !== head.sha256 || sent.bytes !== head.bytes) {
        await failed('sent_hash_mismatch');
        return;
      }
      await recordDeliveryEvent(d, {
        entitlement_id: view.entitlement_id,
        kind,
        link_id,
        source: 'system',
        evidence: { bytes: sent.bytes, sha256: sent.sha256, mode: i.mode },
      });
    },
    async onAbort(sent_bytes) {
      await recordDeliveryEvent(d, {
        entitlement_id: view.entitlement_id,
        kind: 'download_aborted',
        link_id,
        source: 'system',
        evidence: { sent_bytes, mode: i.mode },
      });
    },
  });
}
