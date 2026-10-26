// PG-1: DATABASE_URL parsing and redaction. No server is needed here: a bad URL and an unreachable
// socket must fail without the URL, user, password or host ever appearing in a message or stack.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './index';
import { parsePgUrl, PgConfigError } from './pg';

const SECRET = 'S3cr3tPassw0rdXYZ';

function everything(e: unknown): string {
  const err = e as Error & { cause?: unknown };
  return [
    String(err),
    err.message,
    err.stack ?? '',
    inspect(err, { depth: 6 }),
    (() => {
      try {
        return JSON.stringify(err, Object.getOwnPropertyNames(err));
      } catch {
        return '';
      }
    })(),
  ].join('\n');
}

describe('parsePgUrl', () => {
  it('parses the TCP form with sslmode=require', () => {
    const p = parsePgUrl('postgres://appuser:pw1@db.example.com:6543/umsdb?sslmode=require');
    expect(p.host).toBe('db.example.com');
    expect(p.port).toBe(6543);
    expect(p.user).toBe('appuser');
    expect(p.database).toBe('umsdb');
    expect(p.ssl).not.toBe(false);
    expect(p.socket).toBe(false);
  });

  it('parses the Cloud SQL socket form (empty host, host= query)', () => {
    const p = parsePgUrl('postgres://u:p@/db?host=/cloudsql/proj:europe-west2:inst');
    expect(p.host).toBe('/cloudsql/proj:europe-west2:inst');
    expect(p.socket).toBe(true);
    expect(p.port).toBe(5432);
    expect(p.user).toBe('u');
    expect(p.database).toBe('db');
    expect(p.ssl).toBe(false);
  });

  it('accepts the postgresql:// scheme and percent-escapes in the password', () => {
    const p = parsePgUrl('postgresql://u:p%40ss%2Fw%3Ard@localhost/db');
    expect(p.host).toBe('localhost');
    expect(p.port).toBe(5432);
    expect(p.password).toBe('p@ss/w:rd');
  });

  it('sslmode: disable is no TLS; verify-full verifies; a remote host without sslmode requires TLS', () => {
    expect(parsePgUrl('postgres://u:p@h.example.com/db?sslmode=disable').ssl).toBe(false);
    expect(parsePgUrl('postgres://u:p@h.example.com/db?sslmode=verify-full').ssl).toEqual(
      expect.objectContaining({ rejectUnauthorized: true }),
    );
    expect(parsePgUrl('postgres://u:p@h.example.com/db').ssl).not.toBe(false);
    expect(parsePgUrl('postgres://u:p@localhost/db').ssl).toBe(false);
    expect(parsePgUrl('postgres://u:p@127.0.0.1/db').ssl).toBe(false);
  });

  it('keeps the password out of enumeration, JSON and inspect', () => {
    const p = parsePgUrl(`postgres://u:${SECRET}@localhost/db`);
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(inspect(p)).not.toContain(SECRET);
    expect(Object.keys(p)).not.toContain('password');
  });

  const bad: Array<[string, string]> = [
    ['not a url at all', `not a url ${SECRET}`],
    ['wrong scheme', `mysql://leakuser:${SECRET}@leakhost.example/db`],
    ['bad port', `postgres://leakuser:${SECRET}@leakhost.example:99999x/db`],
    ['no database', `postgres://leakuser:${SECRET}@leakhost.example/`],
    ['bad sslmode', `postgres://leakuser:${SECRET}@leakhost.example/db?sslmode=bogus`],
    ['bad escape', `postgres://leakuser:${SECRET}%zz@leakhost.example/db`],
    ['empty', ''],
  ];
  it.each(bad)('a bad URL (%s) throws PgConfigError with no part of the URL in it', (_n, url) => {
    let caught: unknown;
    try {
      parsePgUrl(url);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PgConfigError);
    const text = everything(caught);
    for (const needle of [SECRET, 'leakuser', 'leakhost', 'mysql://']) {
      expect(text).not.toContain(needle);
    }
  });
});

describe('openDatabase({ kind: "postgres" }) failures', () => {
  it('a bad URL rejects with PgConfigError and leaks nothing', async () => {
    const url = `postgres://leakuser:${SECRET}@leakhost.example:notaport/db`;
    const e = await openDatabase({ kind: 'postgres', url }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(PgConfigError);
    const text = everything(e);
    for (const needle of [SECRET, 'leakuser', 'leakhost']) expect(text).not.toContain(needle);
  });

  it('an unreachable socket rejects without user, password, path or url in the error', async () => {
    const url = `postgres://leakuser:${SECRET}@/leakdb?host=/nonexistent-ums-dir-xyz`;
    const e = await openDatabase({
      kind: 'postgres',
      url,
      connect_timeout_ms: 2000,
    }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    const text = everything(e);
    for (const needle of [SECRET, 'leakuser', 'leakdb', 'nonexistent-ums-dir-xyz', 'postgres://']) {
      expect(text).not.toContain(needle);
    }
    expect((e as Error).message).toMatch(/database connection failed/);
  });

  it('pool_max must be a whole number from 1 to 100', async () => {
    for (const pool_max of [0, -1, 1.5, 101, Number.NaN]) {
      const e = await openDatabase({
        kind: 'postgres',
        url: 'postgres://u:p@/db?host=/nonexistent-ums-dir-xyz',
        pool_max,
      }).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, String(pool_max)).toBeInstanceOf(PgConfigError);
    }
  });
});
