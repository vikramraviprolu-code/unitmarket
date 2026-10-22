import { MAX_RESPONSE_BYTES, mapFetchError, readCapped } from './wire-map';
import type { Wire, WireRequest, WireResult } from './wire';

// THE production Wire, and the only place in the workspace that calls the platform HTTP client.
// Only sandbox.ts imports this file (a test pins both facts). Nothing here is reachable until the
// approved sandbox transport has passed the egress guard and the outbound gate.
//
// Hard limits: redirects are an error, no credentials or cookies are sent or kept (Node's fetch has no cookie
// jar or HTTP cache), the whole exchange has one deadline, the body is capped at 1 MiB.

const fail = (error: Extract<WireResult, { kind: 'error' }>['error']): WireResult => ({
  kind: 'error',
  error,
});

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
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const OVERRIDE_FLAG =
  /^(?:--use-env-proxy|--require|-r|--import|--inspect(?:-brk|-wait)?|--loader|--experimental-loader|--use-system-ca|--use-openssl-ca|--openssl-config|--openssl-shared-config)(?:=|$)/;
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

export function createFetchWire(): Wire {
  return {
    async request(r: WireRequest): Promise<WireResult> {
      if (networkOverridden()) return fail('other');
      let url: URL;
      try {
        url = new URL(r.url);
      } catch {
        return fail('other');
      }
      // Defence in depth: the transport already passed the guard.
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
        return fail('other');
      if (url.port !== '' || url.hash !== '') return fail('other');
      try {
        const res = await fetch(url.href, {
          method: r.method,
          headers: r.headers,
          ...(r.body === null ? {} : { body: r.body }),
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(r.timeout_ms),
        });
        const body = await readCapped(res, MAX_RESPONSE_BYTES);
        if (body.kind === 'too_large') return fail('too_large');
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { kind: 'response', status: res.status, headers, body: body.text };
      } catch (e) {
        return fail(mapFetchError(e));
      }
    },
  };
}
