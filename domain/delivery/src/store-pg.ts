// ContentStore over the Postgres content_blobs table (bytea). Read-only: there is no write or
// upload function in this package (SOP 16, no uploads in MVP-A); seed code writes blobs elsewhere.
// node:crypto (hashing only) is allowed for this file by name in eslint.config.mjs.
import { createHash } from 'node:crypto';
import type { ContentHead, ContentStore, Database, Sha256Hex } from '@umsbx/contracts';

const CHUNK = 64 * 1024;

interface BlobRow {
  data: Uint8Array;
  mime: string;
}

export function createPgContentStore(db: Database): ContentStore {
  const load = async (key: string): Promise<BlobRow | null> => {
    const r = await db.query<BlobRow>(
      'SELECT data, mime FROM content_blobs WHERE content_key = $1',
      [key],
    );
    const row = r.rows[0];
    return row === undefined ? null : { data: new Uint8Array(row.data), mime: row.mime };
  };
  return {
    // The hash is recomputed from the stored bytes, so altered bytes surface as a hash mismatch.
    async head(key): Promise<ContentHead | null> {
      const row = await load(key);
      if (row === null) return null;
      const sha256 = createHash('sha256').update(row.data).digest('hex') as Sha256Hex;
      return { bytes: row.data.length, sha256, mime: row.mime };
    },
    async open(key): Promise<AsyncIterable<Uint8Array> | null> {
      const row = await load(key);
      if (row === null) return null;
      const data = row.data;
      return {
        async *[Symbol.asyncIterator]() {
          for (let at = 0; at < data.length; at += CHUNK) yield data.subarray(at, at + CHUNK);
        },
      };
    },
    async health(): Promise<boolean> {
      try {
        await db.query('SELECT 1 FROM content_blobs LIMIT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
