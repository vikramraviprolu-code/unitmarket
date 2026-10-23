// Test helper for the node:https production Wire (BU-1). Not exported from the package index and
// imported by test files only. It never opens a socket: the "network" is an in-memory request
// function that behaves like http(s).request (an EventEmitter with write/end/destroy, a response
// that is a Readable), plus fake node:https / node:tls / node:dns modules so the real
// createHttpsWire() can be loaded against them (vi.doMock) and every captured builtin is a fake.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import https from 'node:https';
import { vi } from 'vitest';

export type Chunk = string | Uint8Array;

export type Step =
  /** Connects, answers with a status line, headers and a body, then ends (or resets). */
  | {
      kind: 'response';
      status?: number;
      headers?: Record<string, string | string[]>;
      chunks?: Chunk[];
      /**
       * 'end' (default) ends the body; 'reset' destroys the response with an ECONNRESET error;
       * 'close' destroys it with no error (the connection just closes before the end).
       */
      then?: 'end' | 'reset' | 'close';
    }
  /** Connects and answers the head, then never sends the rest of the body. */
  | { kind: 'stall-body'; status?: number; chunks?: Chunk[] }
  /** Emits an error on the request, with an optional Node-style code. */
  | { kind: 'request-error'; code?: string; name?: string; message?: string }
  /** Connects and then never answers. */
  | { kind: 'hang' }
  /** Hands out a socket that never finishes connecting. */
  | { kind: 'connect-hang' };

export type Script = Step | ((call: FakeCall, n: number) => Step);

export interface FakeCall {
  /** The options object exactly as the Wire handed it to the request function. */
  options: Record<string, unknown>;
  /** Everything written to the request. */
  body: string;
  ended: boolean;
  reqDestroyed: boolean;
  resDestroyed: boolean;
  socketDestroyed: boolean;
}

type Cb = (res: unknown) => void;

export function fakeRequest(script: Script = { kind: 'response' }) {
  const calls: FakeCall[] = [];
  const request = (options: Record<string, unknown>, cb?: Cb) => {
    const call: FakeCall = {
      options,
      body: '',
      ended: false,
      reqDestroyed: false,
      resDestroyed: false,
      socketDestroyed: false,
    };
    calls.push(call);
    const step = typeof script === 'function' ? script(call, calls.length) : script;
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req['write'] = (c: unknown) => {
      call.body += String(c);
      return true;
    };
    req['end'] = (c?: unknown) => {
      if (typeof c === 'string') call.body += c;
      call.ended = true;
      queueMicrotask(() => play(call, step, req, cb));
      return req;
    };
    req['destroy'] = (err?: Error) => {
      if (call.reqDestroyed) return req;
      call.reqDestroyed = true;
      call.socketDestroyed = true;
      queueMicrotask(() => {
        if (err !== undefined) req.emit('error', err);
        req.emit('close');
      });
      return req;
    };
    req['setTimeout'] = () => req;
    req['setNoDelay'] = () => req;
    req['setSocketKeepAlive'] = () => req;
    return req;
  };
  return { request, calls };
}

const nodeError = (code: string | undefined, message: string, name?: string): Error => {
  const e = new Error(message);
  if (code !== undefined) Object.assign(e, { code });
  if (name !== undefined) e.name = name;
  return e;
};

function play(
  call: FakeCall,
  step: Step,
  req: EventEmitter & Record<string, unknown>,
  cb: Cb | undefined,
): void {
  if (call.reqDestroyed) return;
  const socket = Object.assign(new EventEmitter(), {
    connecting: true,
    getProtocol: () => null,
    destroy() {
      call.socketDestroyed = true;
    },
  });
  req.emit('socket', socket);
  if (step.kind === 'connect-hang') return;
  if (step.kind === 'request-error') {
    queueMicrotask(() =>
      req.emit('error', nodeError(step.code, step.message ?? 'fake failure', step.name)),
    );
    return;
  }
  socket.connecting = false;
  socket.emit('secureConnect');
  if (step.kind === 'hang') return;

  const chunks = step.chunks ?? [];
  const res = new Readable({ read() {} }) as Readable & Record<string, unknown>;
  res['statusCode'] = step.status ?? 200;
  res['headers'] = lower(step.kind === 'response' ? (step.headers ?? {}) : {});
  const destroy = res.destroy.bind(res);
  res.destroy = (e?: Error) => {
    call.resDestroyed = true;
    return destroy(e);
  };
  cb?.(res);
  void (async () => {
    for (const c of chunks) {
      await Promise.resolve();
      if (res.destroyed) return;
      res.push(Buffer.from(c));
    }
    if (step.kind === 'stall-body') return;
    await Promise.resolve();
    if (res.destroyed) return;
    if (step.then === 'reset') res.destroy(nodeError('ECONNRESET', 'aborted'));
    else if (step.then === 'close') res.destroy();
    else res.push(null);
  })();
}

function lower(h: Record<string, string | string[]>): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

// ---- fake builtin modules ------------------------------------------------------------------

/**
 * Fake `node:https`, `node:tls` and `node:dns` module objects. `Agent` is the real class (building
 * one opens nothing); `request`, `tls.connect` and `dns.lookup` are fakes that count calls.
 */
export interface WorldOptions {
  /** Extra CAs that the fake default trust store holds at load (system or extra CAs). */
  extraDefaultCAs?: string[];
  /** The fake tls module has no getCACertificates (an older Node): the roots are tls.rootCertificates. */
  noGetCACertificates?: boolean;
}

export const BUNDLED_ROOTS = ['BUNDLED-ROOT-1', 'BUNDLED-ROOT-2', 'BUNDLED-ROOT-3'];

export function fakeWorld(script?: Script, opts: WorldOptions = {}) {
  const { request, calls } = fakeRequest(script);
  const lookup = vi.fn((_host: string, _o: unknown, cb: (...a: unknown[]) => void) =>
    cb(null, '192.0.2.1', 4),
  );
  const connect = vi.fn(() => new EventEmitter());
  const checkServerIdentity = vi.fn(() => undefined);
  // The default trust store, as getCACertificates('default') reports it; setDefaultCACertificates
  // replaces it, as Node 22.22 does.
  const store = { default: [...BUNDLED_ROOTS, ...(opts.extraDefaultCAs ?? [])] };
  const getCACertificates = vi.fn((kind: string = 'default') =>
    kind === 'bundled' ? [...BUNDLED_ROOTS] : [...store.default],
  );
  const setDefaultCACertificates = vi.fn((certs: string[]) => {
    store.default = [...certs];
  });
  const tls: Record<string, unknown> = {
    connect,
    checkServerIdentity,
    rootCertificates: [...BUNDLED_ROOTS],
    setDefaultCACertificates,
  };
  if (opts.noGetCACertificates !== true) tls['getCACertificates'] = getCACertificates;
  return {
    calls,
    request,
    lookup,
    connect,
    checkServerIdentity,
    getCACertificates,
    setDefaultCACertificates,
    store,
    https: { request, get: request, Agent: https.Agent } as Record<string, unknown>,
    tls,
    dns: { lookup } as Record<string, unknown>,
  };
}
export type FakeWorld = ReturnType<typeof fakeWorld>;

/**
 * Loads a fresh copy of wire-https.ts (and wire-selfcheck.ts) whose captured `https.request`,
 * `tls.connect` and `dns.lookup` are the fake world's. Call `unloadHttpsWire()` in afterEach.
 */
export async function loadHttpsWire(script?: Script, opts: WorldOptions = {}) {
  const world = fakeWorld(script, opts);
  vi.resetModules();
  vi.doMock('node:https', () => ({ default: world.https, ...world.https }));
  vi.doMock('node:tls', () => ({ default: world.tls, ...world.tls }));
  vi.doMock('node:dns', () => ({ default: world.dns, ...world.dns }));
  const wire = await import('./wire-https');
  const selfcheck = await import('./wire-selfcheck');
  return { world, ...wire, wireSelfCheck: selfcheck.wireSelfCheck };
}
export function unloadHttpsWire(): void {
  vi.doUnmock('node:https');
  vi.doUnmock('node:tls');
  vi.doUnmock('node:dns');
  vi.resetModules();
}

// ---- a clean process for the per-request override check -------------------------------------

export const OVERRIDE_ENV_NAMES = [
  'NODE_USE_ENV_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NODE_USE_SYSTEM_CA',
  'NODE_PRESERVE_SYMLINKS',
  'NODE_PATH',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/**
 * Replaces the Node flags the process reports, in place (the array object stays the same, which is
 * all the Wire reads). Returns the function that puts the previous flags back.
 */
export function setExecArgv(argv: string[]): () => void {
  const saved = [...process.execArgv];
  process.execArgv.splice(0, process.execArgv.length, ...argv);
  return () => {
    process.execArgv.splice(0, process.execArgv.length, ...saved);
  };
}

/**
 * Empties every override variable (in both cases) and every Node flag for the current test, because
 * the test runner's own workers carry --require and the container sets HTTPS_PROXY. Returns the
 * function that puts the flags back; the caller also runs vi.unstubAllEnvs().
 */
export function cleanProcess(): () => void {
  for (const n of OVERRIDE_ENV_NAMES) {
    vi.stubEnv(n, '');
    vi.stubEnv(n.toLowerCase(), '');
  }
  return setExecArgv([]);
}

// ---- full dependency sets for makeHttpsWire -------------------------------------------------

const noLookup = (() => undefined) as unknown as typeof import('node:dns').lookup;
const noIdentity = (() => undefined) as unknown as typeof import('node:tls').checkServerIdentity;

/** A complete HttpsWireDeps around a fake request function; `over` replaces any field. */
export function testDeps(
  request: ReturnType<typeof fakeRequest>['request'],
  over: Record<string, unknown> = {},
) {
  return {
    request: request as unknown as typeof https.request,
    agent: new https.Agent({ keepAlive: false }),
    lookup: noLookup,
    checkServerIdentity: noIdentity,
    ca: [...BUNDLED_ROOTS],
    builtinsIntact: () => true,
    envOverridden: () => false,
    ...over,
  };
}
