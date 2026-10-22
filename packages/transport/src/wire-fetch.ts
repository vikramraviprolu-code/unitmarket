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

export function createFetchWire(): Wire {
  return {
    async request(r: WireRequest): Promise<WireResult> {
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
