// INT-SR1 (SR1.6): the filters of the library list: purchased date (from, to; UTC days), seller (name, slug
// or id), item text (q) and access state (available, ended, revoked). Pure: the caller gives the entries and
// the stored facts the entries do not carry (purchase time and seller id). A value that does not parse is
// dropped, like every other search filter. `limit` and `cursor` are read here too; paging stays with the
// caller, which binds the cursor to the query and the buyer.
import { parseTxnQuery } from '@umsbx/contracts';
import type { AccessState } from '@umsbx/contracts';

const ACCESS_VALUES: readonly AccessState[] = ['available', 'ended', 'revoked'];

export interface LibraryQuery {
  from?: string;
  to?: string;
  seller?: string;
  q?: string;
  access?: AccessState[];
  limit?: number;
  cursor?: string;
}

export interface LibraryFacts {
  /** When the entitlement was created (the purchase), ISO UTC. */
  created_at: string;
  publisher_id: string;
  publisher_slug: string;
}

export interface LibraryLike {
  entitlement_id: string;
  title: string;
  publisher: string;
  access: string;
}

type Raw = Readonly<Record<string, string | undefined>>;

export function parseLibraryQuery(raw: Raw): LibraryQuery {
  const t = parseTxnQuery(raw);
  const out: LibraryQuery = {};
  if (t.from !== undefined) out.from = t.from;
  if (t.to !== undefined) out.to = t.to;
  if (t.seller !== undefined) out.seller = t.seller;
  if (t.q !== undefined) out.q = t.q;
  if (t.limit !== undefined) out.limit = t.limit;
  if (t.cursor !== undefined) out.cursor = t.cursor;
  const a = Object.hasOwn(raw, 'access') ? raw['access'] : undefined;
  if (typeof a === 'string') {
    const wanted = a
      .split(',')
      .map((x) => x.trim())
      .filter((x): x is AccessState => (ACCESS_VALUES as readonly string[]).includes(x));
    if (wanted.length > 0) out.access = [...new Set(wanted)];
  }
  return out;
}

/** True when no filter, limit or cursor was given: the list answers every entry, as before. */
export const isPlainLibraryQuery = (q: LibraryQuery): boolean => Object.keys(q).length === 0;

const nextDay = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;

export function filterLibrary<T extends LibraryLike>(
  items: readonly T[],
  facts: ReadonlyMap<string, LibraryFacts>,
  q: LibraryQuery,
): T[] {
  const seller = q.seller?.toLowerCase();
  const text = q.q?.toLowerCase();
  return items.filter((it) => {
    const f = facts.get(it.entitlement_id);
    if (q.from !== undefined || q.to !== undefined) {
      if (f === undefined) return false;
      const at = Date.parse(f.created_at);
      if (q.from !== undefined && at < Date.parse(`${q.from}T00:00:00.000Z`)) return false;
      if (q.to !== undefined && at >= nextDay(q.to)) return false;
    }
    if (seller !== undefined) {
      const named = it.publisher.toLowerCase().includes(seller);
      const exact =
        f !== undefined &&
        (f.publisher_id === q.seller || f.publisher_slug.toLowerCase() === seller);
      if (!named && !exact) return false;
    }
    if (text !== undefined && !it.title.toLowerCase().includes(text)) return false;
    if (q.access !== undefined && !(q.access as readonly string[]).includes(it.access))
      return false;
    return true;
  });
}
