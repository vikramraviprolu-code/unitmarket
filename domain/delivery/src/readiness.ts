// Readiness probe run before any charge (A-17): the object is present, its hash equals the
// snapshot, and the link signer works. Writes nothing.
import { err, ok } from '@umsbx/contracts';
import type { ContentStore, CoreDeps, Id, Result, Sha256Hex } from '@umsbx/contracts';
import { makeLinkToken, readLinkToken } from './link-token';

export type ReadinessError = {
  code: 'missing' | 'hash_mismatch' | 'signer_failed' | 'store_unavailable';
};

export async function checkReadiness(
  d: CoreDeps & { content: ContentStore },
  i: { article_id: Id; expected_sha256: Sha256Hex },
): Promise<Result<{ link_probe: 'ok'; content_sha256: Sha256Hex }, ReadinessError>> {
  let key: string | undefined;
  let head;
  try {
    if (!(await d.content.health())) return err({ code: 'store_unavailable' });
    const a = await d.db.query<{ content_key: string }>(
      'SELECT content_key FROM articles WHERE id = $1',
      [i.article_id],
    );
    key = a.rows[0]?.content_key;
    if (key === undefined) return err({ code: 'missing' });
    head = await d.content.head(key);
  } catch {
    return err({ code: 'store_unavailable' });
  }
  if (head === null) return err({ code: 'missing' });
  if (head.sha256 !== i.expected_sha256) return err({ code: 'hash_mismatch' });
  try {
    const now = d.clock.now();
    const exp_unix = Math.floor(now.getTime() / 1000) + 60;
    const token = makeLinkToken(d.config.link_secret, { link_id: 'lnk_readiness_probe', exp_unix });
    const back = readLinkToken(d.config.link_secret, token, now);
    if (!back.ok || back.value.link_id !== 'lnk_readiness_probe') {
      return err({ code: 'signer_failed' });
    }
  } catch {
    return err({ code: 'signer_failed' });
  }
  return ok({ link_probe: 'ok', content_sha256: head.sha256 });
}
