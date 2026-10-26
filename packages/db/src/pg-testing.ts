// TEST ONLY (PG-1). A throwaway real Postgres 16 for tests: `initdb` in a temp directory, a server that
// listens on a unix socket in that directory only (no TCP port, no network), removed after use.
// Binaries come from UMS_TEST_PG_BIN, default /usr/lib/postgresql/16/bin. Never import this from product
// code, and it never touches any other database: every name it creates lives on its own server.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  chownSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BIN = '/usr/lib/postgresql/16/bin';
const PORT = 54329; // names the socket file only; the server has no TCP listener

export function pgBinDir(): string {
  const fromEnv = process.env['UMS_TEST_PG_BIN'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_BIN;
}

/** True when initdb and postgres are present, so a real-Postgres suite can run. */
export function pgAvailable(): boolean {
  const bin = pgBinDir();
  return existsSync(join(bin, 'initdb')) && existsSync(join(bin, 'postgres'));
}

export interface TestDatabase {
  name: string;
  /** Socket-form URL for this database. Test credentials only (trust auth, no password). */
  url: string;
}

export interface TestPostgres {
  readonly socketDir: string;
  urlFor(database: string): string;
  /** Creates `<prefix>_<pid>_<n>` (default prefix `ums_test`) and returns its URL. */
  createDatabase(prefix?: string): Promise<TestDatabase>;
  dropDatabase(name: string): Promise<void>;
  /** Stops the server and removes its directory (a no-op for a server this process only attached to). */
  stop(): Promise<void>;
}

let counter = 0;

function urlFor(socketDir: string, database: string): string {
  return `postgres://postgres@:${PORT}/${database}?host=${encodeURIComponent(socketDir)}`;
}

async function adminRun(socketDir: string, sql: string): Promise<void> {
  const { Client } = (await import('pg')).default;
  const c = new Client({ host: socketDir, port: PORT, user: 'postgres', database: 'postgres' });
  c.on('error', () => undefined);
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end().catch(() => undefined);
  }
}

function handle(socketDir: string, stop: () => Promise<void>): TestPostgres {
  return {
    socketDir,
    urlFor: (database) => urlFor(socketDir, database),
    createDatabase: async (prefix = 'ums_test') => {
      counter += 1;
      const name = `${prefix}_${process.pid}_${counter}`;
      await adminRun(socketDir, `CREATE DATABASE "${name}"`);
      return { name, url: urlFor(socketDir, name) };
    },
    dropDatabase: (name) => adminRun(socketDir, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    stop,
  };
}

/** Attaches to a server another process started (the vitest global setup). Never stops it. */
export function attachTestPostgres(socketDir: string): TestPostgres {
  return handle(socketDir, async () => undefined);
}

function postgresUser(): { uid: number; gid: number } | null {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === 'postgres') return { uid: Number(f[2]), gid: Number(f[3]) };
    }
  } catch {
    /* fall through */
  }
  throw new Error('running as root and there is no postgres user to run initdb as');
}

/** initdb and start a throwaway server on a unix socket in a new temp directory. */
export async function startTestPostgres(): Promise<TestPostgres> {
  const bin = pgBinDir();
  if (!pgAvailable()) throw new Error(`Postgres 16 binaries not found in ${bin}`);
  // The socket path must stay under about 100 bytes.
  let root = tmpdir();
  if (root.length > 50) root = '/tmp';
  const dir = mkdtempSync(join(root, 'ums-pg-'));
  const owner = postgresUser();
  if (owner !== null) chownSync(dir, owner.uid, owner.gid);
  const ids = owner === null ? {} : { uid: owner.uid, gid: owner.gid };
  const data = join(dir, 'data');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  const init = spawnSync(
    join(bin, 'initdb'),
    ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-sync'],
    { ...ids, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', LANG: 'C' } },
  );
  if (init.status !== 0) {
    cleanup();
    throw new Error(`initdb failed: ${(init.stderr ?? '').slice(-400)}`);
  }
  const logFd = openSync(join(dir, 'server.log'), 'a');
  if (owner !== null) chownSync(join(dir, 'server.log'), owner.uid, owner.gid);
  const child: ChildProcess = spawn(
    join(bin, 'postgres'),
    [
      '-D',
      data,
      '-k',
      dir,
      '-p',
      String(PORT),
      '-c',
      'listen_addresses=',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'max_connections=300',
      '-c',
      'shared_buffers=64MB',
      '-c',
      'log_min_messages=warning',
    ],
    {
      ...ids,
      stdio: ['ignore', logFd, logFd],
      env: { PATH: process.env['PATH'] ?? '', LANG: 'C' },
    },
  );
  closeSync(logFd);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const onExit = () => {
    if (!exited && child.pid !== undefined) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    cleanup();
  };
  process.once('exit', onExit);

  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      process.removeListener('exit', onExit);
      if (!exited) {
        const gone = new Promise<void>((r) => child.once('exit', () => r()));
        child.kill('SIGINT'); // fast shutdown
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await gone;
        clearTimeout(timer);
      }
      cleanup();
    })();
    return stopped;
  };

  // Wait until it accepts connections.
  const { Client } = (await import('pg')).default;
  for (let attempt = 0; ; attempt += 1) {
    if (exited) {
      const log = existsSync(join(dir, 'server.log'))
        ? readFileSync(join(dir, 'server.log'), 'utf8')
        : '';
      cleanup();
      throw new Error(`postgres exited during start: ${log.slice(-400)}`);
    }
    const c = new Client({ host: dir, port: PORT, user: 'postgres', database: 'postgres' });
    c.on('error', () => undefined);
    try {
      await c.connect();
      await c.end();
      break;
    } catch {
      await c.end().catch(() => undefined);
      if (attempt >= 300) {
        await stop();
        throw new Error('postgres did not accept connections within 30 s');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return handle(dir, stop);
}
