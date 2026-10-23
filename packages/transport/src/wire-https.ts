import dns from 'node:dns';
import https from 'node:https';
import tls from 'node:tls';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { MAX_RESPONSE_BYTES, mapFetchError } from './wire-map';
import { registerWireProbe } from './wire-selfcheck';
import type { Wire, WireErrorKind, WireRequest, WireResult } from './wire';

// THE production Wire (BU-1, replaces the global-fetch Wire), and the only place in the workspace
// that calls the platform HTTP client. Only sandbox.ts imports this file (a test pins that).
// Nothing here is reachable until the approved sandbox transport has passed the egress guard and
// the outbound gate.
//
// Why node:https and not the platform fetch: Next.js patches the global fetch (and a user can swap
// the undici dispatcher) after this module loads. A Wire built on them either fails closed on every
// call or sends through the framework's wrapper. This Wire never reads the global fetch except to
// REPORT that it changed (wireSelfCheck). It keeps the request function, the DNS lookup and
// tls.connect it found when the module loaded, owns its https.Agent (no keep-alive, no TLS session
// cache), and refuses every request if any of the three was replaced since.
//
// Hard limits (architecture 7.6): TLS 1.2 or newer with certificate and host name checks on, a 3 s
// connect deadline (DNS, TCP and the TLS handshake), a 10 s total deadline, a 1 MiB response cap read
// as a stream, no redirect following (a 3xx is handed back as a response and its Location is never
// requested), no credentials or cookies kept (this client has no cookie jar and no cache).

/** Connect deadline: from the socket being assigned to the TLS handshake finishing. */
export const CONNECT_TIMEOUT_MS = 3000;
/** Total deadline for one exchange; a caller can shorten it but never lengthen it. */
export const TOTAL_DEADLINE_MS = 10_000;

const fail = (error: WireErrorKind): WireResult => ({ kind: 'error', error });

// Headers the PayPal adapter needs. Everything else is dropped here as well as in the transport.
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'accept',
  'content-type',
  'prefer',
  'paypal-request-id',
]);
const HEADER_VALUE = /^[\x20-\x7e]*$/;

// FIX-MVPB-SEAL2 M3. A proxy, a replaced trust store or a Node flag that loads code can see the
// client secret. packages/config refuses them at boot; this Wire asks again before EVERY request,
// because process.env can change after boot and Node reads NODE_TLS_REJECT_UNAUTHORIZED at each
// connection. This file is a named lint exemption (it reads process.env and process.execArgv);
// the list is the same as packages/config load.ts and tools/spike-kit spike.ts.
const OVERRIDE_NAMES: ReadonlySet<string> = new Set([
  'NODE_USE_ENV_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NODE_USE_SYSTEM_CA',
  'NODE_PRESERVE_SYMLINKS',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const OVERRIDE_FLAG =
  /^(?:--use-env-proxy|--require|-r|--import|--inspect(?:-brk|-wait|-port|-publish-uid)?|--loader|--experimental-loader|--use-system-ca|--use-openssl-ca|--openssl-config|--openssl-shared-config|--tls-keylog|--tls-min-v1\.[01]|--heapsnapshot-signal|--heapsnapshot-near-heap-limit|--experimental-network-inspection|--secure-heap(?:-min)?|--conditions|-C|--preserve-symlinks(?:-main)?|--report-[a-z-]+|--snapshot-blob|--build-snapshot)(?:=|$)/;

function networkOverridden(): boolean {
  try {
    for (const [name, v] of Object.entries(process.env)) {
      if (OVERRIDE_NAMES.has(name.toUpperCase()) && v !== undefined && v.trim() !== '') return true;
    }
    return process.execArgv.some((a) => OVERRIDE_FLAG.test(a));
  } catch {
    return true; // cannot tell: refuse
  }
}

// What this module found when it loaded. A later replacement of any of them stops every request.
const LOAD = {
  request: https.request,
  connect: tls.connect,
  lookup: dns.lookup,
  Agent: https.Agent,
};
const builtinsIntact = (): boolean =>
  https.request === LOAD.request && tls.connect === LOAD.connect && dns.lookup === LOAD.lookup;

// The Wire never calls the global fetch; it only remembers which one existed at load, to report.
const currentFetch = (): unknown => Reflect.get(globalThis, 'fetch');
const FETCH_AT_LOAD = currentFetch();

registerWireProbe({
  envOverride: networkOverridden,
  builtinsIntact,
  fetchChanged: () => currentFetch() !== FETCH_AT_LOAD,
});

/** An agent of this Wire's own that opens its sockets with the tls.connect captured at load. */
class OwnAgent extends LOAD.Agent {
  override createConnection(options: object): ReturnType<typeof tls.connect> {
    return LOAD.connect(options as tls.ConnectionOptions);
  }
}

export interface HttpsWireDeps {
  /** The request function (https.request captured at load; a fake in tests). */
  request: typeof https.request;
  agent: https.Agent;
  /** dns.lookup captured at load; handed to the socket as its resolver. */
  lookup: typeof dns.lookup;
  /** False when https.request, tls.connect or dns.lookup is no longer what was captured. */
  builtinsIntact(): boolean;
  /** True when a proxy, trust-store, loader or Node flag override is present. */
  envOverridden(): boolean;
}

interface Prepared {
  options: https.RequestOptions;
  body: string | null;
  deadline: number;
}

/** The checked request, or null when anything about it is off. Pure: no I/O. */
function prepare(r: WireRequest, deps: HttpsWireDeps): Prepared | null {
  if (r.method !== 'GET' && r.method !== 'POST') return null;
  if (r.method === 'GET' && r.body !== null) return null;
  if (typeof r.timeout_ms !== 'number' || !Number.isFinite(r.timeout_ms) || r.timeout_ms <= 0)
    return null;
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return null;
  }
  // Defence in depth: the transport already passed the guard.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if (url.port !== '' || url.hash !== '' || url.hostname === '') return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(r.headers)) {
    const key = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(key)) continue;
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) return null;
    headers[key] = value;
  }
  return {
    options: {
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: r.method,
      headers,
      agent: deps.agent,
      lookup: deps.lookup,
      servername: url.hostname,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      insecureHTTPParser: false,
    },
    body: r.body,
    deadline: Math.min(r.timeout_ms, TOTAL_DEADLINE_MS),
  };
}

function responseHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(h)) {
    if (v === undefined || name === '__proto__') continue;
    out[name.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Internal: builds the Wire from its dependencies. Used by createHttpsWire and by its tests. */
export function makeHttpsWire(deps: HttpsWireDeps): Wire {
  return {
    request(r: WireRequest): Promise<WireResult> {
      return new Promise<WireResult>((resolve) => {
        let prepared: Prepared | null;
        try {
          if (deps.envOverridden() || !deps.builtinsIntact()) return resolve(fail('other'));
          prepared = prepare(r, deps);
        } catch {
          return resolve(fail('other'));
        }
        if (prepared === null) return resolve(fail('other'));
        const { options, body, deadline } = prepared;

        let finished = false;
        let req: ClientRequest | undefined;
        let res: IncomingMessage | undefined;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const settle = (out: WireResult): void => {
          if (finished) return;
          finished = true;
          for (const t of timers) clearTimeout(t);
          try {
            res?.destroy();
          } catch {
            /* already gone */
          }
          try {
            req?.destroy();
          } catch {
            /* already gone */
          }
          resolve(out);
        };

        timers.push(setTimeout(() => settle(fail('timeout')), deadline));
        try {
          req = deps.request(options, (response: IncomingMessage) => onResponse(response));
        } catch {
          return settle(fail('other'));
        }
        req.on('error', (e: unknown) => settle(fail(mapFetchError(e))));
        req.on('socket', (socket: Socket) => {
          const handshaken =
            socket.connecting !== true &&
            typeof (socket as tls.TLSSocket).getProtocol === 'function' &&
            (socket as tls.TLSSocket).getProtocol() !== null;
          if (handshaken) return;
          const t = setTimeout(
            () => settle(fail('timeout')),
            Math.min(CONNECT_TIMEOUT_MS, deadline),
          );
          timers.push(t);
          socket.once('secureConnect', () => clearTimeout(t));
        });

        function onResponse(response: IncomingMessage): void {
          res = response;
          response.on('error', (e: unknown) => settle(fail(mapFetchError(e))));
          const status = response.statusCode ?? 0;
          if (!Number.isInteger(status) || status < 100 || status > 599)
            return settle(fail('other'));
          const headers = responseHeaders(response.headers);
          // A redirect is handed back as it is; its Location is never requested.
          if (status >= 300 && status <= 399)
            return settle({ kind: 'response', status, headers, body: '' });
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
            return settle(fail('too_large'));
          const chunks: Buffer[] = [];
          let total = 0;
          let ended = false;
          response.on('data', (chunk: Buffer | string) => {
            if (finished) return;
            const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            total += b.byteLength;
            if (total > MAX_RESPONSE_BYTES) return settle(fail('too_large'));
            chunks.push(b);
          });
          response.on('end', () => {
            ended = true;
            settle({
              kind: 'response',
              status,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          response.on('close', () => {
            if (!ended) settle(fail('reset'));
          });
        }

        if (body === null) req.end();
        else req.end(body);
      });
    },
  };
}

/** The production Wire: https.request, its own agent, dns.lookup and tls.connect, all as captured at load. */
export function createHttpsWire(): Wire {
  return makeHttpsWire({
    request: LOAD.request,
    agent: new OwnAgent({ keepAlive: false, maxCachedSessions: 0 }),
    lookup: LOAD.lookup,
    builtinsIntact,
    envOverridden: networkOverridden,
  });
}
