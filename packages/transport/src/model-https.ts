import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { ModelWire, Secret } from '@umsbx/contracts';

// AI-A (D-067). The one egress to the model API, and the only network code outside the sandbox path.
// It is not a general client: one host, one path, POST, a body the caller built. It shares nothing
// with the sandbox Wire, the approval minter or the PayPal endpoints, and it cannot reach them.
//
// Fixed limits: no redirect is followed (a 3xx is handed back with an empty body and its Location is
// never requested), the request body is at most 64 KB, the answer at most 256 KB, the whole exchange
// 20 s. The key is read from the Secret at the moment of the request, goes only into the x-api-key
// header and is never put in an error, a log or a url. Errors carry a fixed kind and no other text.

/** The one host. Not configurable. */
export const MODEL_API = 'https://api.anthropic.com';
export const MODEL_PATH = '/v1/messages';
export const MODEL_API_VERSION = '2026-10-21';
export const MODEL_MAX_REQUEST_BYTES = 64 * 1024;
export const MODEL_MAX_RESPONSE_BYTES = 256 * 1024;
export const MODEL_DEADLINE_MS = 20_000;

const MODEL_URL = `${MODEL_API}${MODEL_PATH}`;
const HOST = new URL(MODEL_API).hostname;
const KEY_SHAPE = /^[\x21-\x7e]{1,256}$/;

export type ModelWireErrorKind =
  'refused' | 'request_too_large' | 'response_too_large' | 'timeout' | 'network';

/** A failed exchange. Only the kind is kept: no url, no header, no key, no text from the peer. */
export class ModelWireError extends Error {
  readonly kind: ModelWireErrorKind;
  constructor(kind: ModelWireErrorKind) {
    super(`model wire: ${kind}`);
    this.name = 'ModelWireError';
    this.kind = kind;
  }
}

export interface ModelHttpsDeps {
  /** The request function (https.request captured at load; a fake in tests). */
  request: typeof https.request;
  agent: https.Agent;
  apiKey: Secret;
}

export interface ModelExchange {
  method: string;
  url: string;
  body: string;
}

/** Internal: builds the wire from its dependencies. Used by createModelHttps and by its tests. */
export function makeModelHttps(
  deps: ModelHttpsDeps,
): ModelWire & { exchange(r: ModelExchange): Promise<{ status: number; body: string }> } {
  function exchange(r: ModelExchange): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const fail = (kind: ModelWireErrorKind): void => reject(new ModelWireError(kind));
      // Everything that can be wrong with the request is checked before a socket exists.
      if (r === null || typeof r !== 'object') return fail('refused');
      if (r.method !== 'POST' || r.url !== MODEL_URL || typeof r.body !== 'string')
        return fail('refused');
      let key: unknown;
      try {
        key = deps.apiKey.reveal();
      } catch {
        return fail('refused');
      }
      if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return fail('refused');
      if (Buffer.byteLength(r.body, 'utf8') > MODEL_MAX_REQUEST_BYTES)
        return fail('request_too_large');

      let finished = false;
      let req: ClientRequest | undefined;
      let res: IncomingMessage | undefined;
      const settle = (done: () => void): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
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
        done();
      };
      const settleFail = (kind: ModelWireErrorKind): void => settle(() => fail(kind));

      const timer = setTimeout(() => settleFail('timeout'), MODEL_DEADLINE_MS);
      try {
        req = deps.request(
          {
            protocol: 'https:',
            hostname: HOST,
            port: 443,
            path: MODEL_PATH,
            method: 'POST',
            headers: {
              'x-api-key': key,
              'anthropic-version': MODEL_API_VERSION,
              'content-type': 'application/json',
            },
            agent: deps.agent,
            servername: HOST,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            insecureHTTPParser: false,
          },
          (response: IncomingMessage) => onResponse(response),
        );
      } catch {
        return settleFail('network');
      }
      req.on('error', () => settleFail('network'));

      function onResponse(response: IncomingMessage): void {
        res = response;
        response.on('error', () => settleFail('network'));
        const status = response.statusCode ?? 0;
        if (!Number.isInteger(status) || status < 100 || status > 599) return settleFail('network');
        // A redirect is handed back as a status; its Location is never requested.
        if (status >= 300 && status <= 399) return settle(() => resolve({ status, body: '' }));
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > MODEL_MAX_RESPONSE_BYTES)
          return settleFail('response_too_large');
        const chunks: Buffer[] = [];
        let total = 0;
        let ended = false;
        response.on('data', (chunk: Buffer | string) => {
          if (finished) return;
          const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          total += b.byteLength;
          if (total > MODEL_MAX_RESPONSE_BYTES) return settleFail('response_too_large');
          chunks.push(b);
        });
        response.on('end', () => {
          ended = true;
          settle(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        });
        response.on('close', () => {
          if (!ended) settleFail('network');
        });
      }

      req.end(r.body);
    });
  }
  return {
    exchange,
    send: (body: string) => exchange({ method: 'POST', url: MODEL_URL, body }),
  };
}

// Captured when this module loads, like the sandbox Wire does: a later replacement of the platform
// request function does not change what this wire calls.
const LOADED_REQUEST = https.request;

/** The production wire: https.request as captured at load, its own agent, no keep-alive. */
export function createModelHttps(o: { apiKey: Secret }): ModelWire {
  const wire = makeModelHttps({
    request: LOADED_REQUEST,
    agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
    apiKey: o.apiKey,
  });
  return { send: wire.send };
}
