// OAuth client-credentials token cache: in memory only, single-flight, refreshed 300 s before
// expiry. The token is never logged or recorded (nfr.md P7).
import { err, ok } from '@umsbx/contracts';
import type { Clock, PayPalFail, Result, Secret, Transport } from '@umsbx/contracts';
import { PATHS } from '@umsbx/transport';
import { mapError } from './errors';
import { debugIdOf, isRecord } from './headers';
import { buildRecord } from './redact-call';
import type { ProviderCallRecord } from './adapter';

const REFRESH_MARGIN_MS = 300_000;

export interface TokenCache {
  get(): Promise<Result<string, PayPalFail>>;
  /** Forget the cached token, e.g. after a 401. */
  invalidate(): void;
}

export function createTokenCache(o: {
  transport: Transport;
  clock: Clock;
  credentials: { client_id: Secret; client_secret: Secret };
  record: (c: ProviderCallRecord) => Promise<void>;
}): TokenCache {
  let cached: { token: string; refreshAtMs: number } | null = null;
  let inflight: Promise<Result<string, PayPalFail>> | null = null;
  const spec = PATHS.oauth_token;

  async function fetchToken(): Promise<Result<string, PayPalFail>> {
    const started = o.clock.now().getTime();
    const basic = Buffer.from(
      `${o.credentials.client_id.reveal()}:${o.credentials.client_secret.reveal()}`,
    ).toString('base64');
    const headers = {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const result = await o.transport.send({
      operation: 'oauth_token',
      method: 'POST',
      path: spec.template,
      headers,
      body: 'grant_type=client_credentials',
      order_ref: null,
      amount_minor: null,
      scenario: null,
    });

    let fail: PayPalFail | null = null;
    let token: string | null = null;
    let expiresIn = 0;
    let httpStatus: number | null = null;
    let debug: string | null = null;
    let duration = Math.max(0, o.clock.now().getTime() - started);
    let body: unknown = null;

    if (result.kind === 'timeout' || result.kind === 'network_error') fail = { kind: 'timeout' };
    else if (result.kind === 'blocked') fail = { kind: 'blocked', by: result.by };
    else {
      httpStatus = result.status;
      duration = result.duration_ms;
      try {
        body = JSON.parse(result.body) as unknown;
      } catch {
        body = null;
      }
      debug = debugIdOf(result.headers, body);
      if (result.status === 200) {
        if (
          isRecord(body) &&
          typeof body.access_token === 'string' &&
          body.access_token.length > 0 &&
          typeof body.expires_in === 'number' &&
          Number.isFinite(body.expires_in) &&
          body.expires_in > 0
        ) {
          token = body.access_token;
          expiresIn = body.expires_in;
        } else fail = { kind: 'unavailable', retry_after_ms: null };
      } else fail = mapError(result.status, body, result.headers);
    }

    // The record never holds the token: the response is reduced to its public shape first.
    const outcome = fail === null ? 'ok' : fail.kind;
    try {
      await o.record(
        buildRecord({
          operation: 'oauth_token',
          method: 'POST',
          path_template: spec.template,
          http_status: httpStatus,
          outcome,
          debug_id: debug,
          duration_ms: duration,
          transport_kind: o.transport.kind,
          request: { headers, body: 'grant_type=client_credentials' },
          response:
            fail === null
              ? { token_type: 'Bearer', expires_in: expiresIn }
              : { status: httpStatus },
        }),
      );
    } catch {
      // a record that cannot be written never changes the answer
    }

    if (fail !== null || token === null)
      return err(fail ?? { kind: 'unavailable', retry_after_ms: null });
    cached = { token, refreshAtMs: started + expiresIn * 1000 - REFRESH_MARGIN_MS };
    return ok(token);
  }

  return {
    get() {
      if (cached !== null && o.clock.now().getTime() < cached.refreshAtMs) {
        return Promise.resolve(ok(cached.token));
      }
      inflight ??= fetchToken().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}
