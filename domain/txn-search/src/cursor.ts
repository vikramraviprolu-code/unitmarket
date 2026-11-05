// INT-SR0 (SR0.1): the keyset cursor of a transaction list.
//
// A cursor is base64url JSON `{v:'t1', s:<sort>, k:<sort value>, id:<unit id>, h:<opaque string>}`. It marks a
// place in one ordering and nothing else: it never carries a buyer, a seller or any other scope value, and the
// query that reads it adds the pin of the caller before it looks at the cursor, so a cursor cannot widen a
// scope. `h` is filled by the caller (the API puts a hash of the query and the principal there). A malformed
// cursor, one for another sort and one with another `h` throw 400 `bad_cursor`; none falls back to page 1.
// There is no signature (a domain package holds no secret): a hand-edited `k` or `id` only moves the place
// inside the caller's own scope.
import type { TxnQuery } from '@umsbx/contracts';

export type TxnSort = NonNullable<TxnQuery['sort']>;

export type TxnSearchErrorCode = 'field_not_allowed' | 'bad_cursor' | 'forbidden';

/** A refusal the API shows as is: `status` is the HTTP status, `code` the machine word. */
export class TxnSearchError extends Error {
  readonly status: 400 | 403;
  readonly code: TxnSearchErrorCode;
  /** The field that was refused (`field_not_allowed`). */
  readonly field: string | undefined;
  constructor(code: TxnSearchErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'TxnSearchError';
    this.code = code;
    this.status = code === 'forbidden' ? 403 : 400;
    this.field = field;
  }
}

export interface TxnCursor {
  v: 't1';
  s: TxnSort;
  /** newest: a UTC timestamp with microseconds; amount: minor units; status: the group rank. */
  k: string | number;
  /** The unit id: the tie-break of every sort. */
  id: string;
  h: string;
}

const SORTS: readonly string[] = ['newest', 'amount', 'status'];
const KEYS = ['h', 'id', 'k', 's', 'v'];
const TOKEN = /^[A-Za-z0-9_-]{1,1000}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID_MAX = 200;
const H_MAX = 200;
// Padding, control characters (\p{Cc}) and invisible format characters such as zero-width marks and
// bidirectional overrides (\p{Cf}).
const BAD_ID = /^\s|\s$|[\p{Cc}\p{Cf}]/u;

const bad = (): TxnSearchError =>
  new TxnSearchError(
    'bad_cursor',
    'That page marker is not valid. Start again from the first page.',
  );

export function encodeCursor(c: Omit<TxnCursor, 'v'>): string {
  // Fields are copied one by one, so nothing else a caller attaches can end up in the token.
  const body = { v: 't1', s: c.s, k: c.k, id: c.id, h: c.h };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** Reads and checks a cursor for the sort and the query hash of the current request. */
export function decodeCursor(token: string, expect: { sort: TxnSort; h: string }): TxnCursor {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw bad();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== KEYS.join(',')) throw bad();
  const { v, s, k, id, h } = o;
  if (v !== 't1') throw bad();
  if (typeof s !== 'string' || !SORTS.includes(s) || s !== expect.sort) throw bad();
  if (s === 'newest') {
    if (typeof k !== 'string' || !STAMP.test(k)) throw bad();
  } else if (typeof k !== 'number' || !Number.isSafeInteger(k) || k < 0) {
    throw bad();
  }
  if (typeof id !== 'string' || id.length < 1 || id.length > ID_MAX || BAD_ID.test(id)) throw bad();
  if (typeof h !== 'string' || h.length > H_MAX || h !== expect.h) throw bad();
  return { v: 't1', s: s as TxnSort, k: k as string | number, id, h };
}
