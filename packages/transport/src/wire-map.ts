import type { WireErrorKind } from './wire';

// Pure helpers for the production Wire. They call no network API, so they are unit-tested.

/** Response cap: 1 MiB (architecture 7 point 6). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

type ReadResult = { kind: 'ok'; text: string } | { kind: 'too_large' };

/** Reads a response body as UTF-8 text and stops as soon as it passes `cap` bytes. */
export async function readCapped(res: Response, cap: number): Promise<ReadResult> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) return { kind: 'too_large' };
  if (res.body === null) return { kind: 'ok', text: '' };
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return { kind: 'too_large' };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { kind: 'ok', text: text + decoder.decode() };
}

const DNS = /^(ENOTFOUND|EAI_[A-Z]+)$/;
const TIMEOUT = /^(ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/;
const CONNECT = /^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL)$/;
const RESET = /^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/;
const TLS = /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|UNABLE_TO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

function codeOf(e: unknown): string {
  if (typeof e !== 'object' || e === null) return '';
  const own = (e as { code?: unknown }).code;
  if (typeof own === 'string') return own;
  const cause = (e as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return '';
}

/** Reduces whatever fetch threw to a kind. The message text is never kept (it can name hosts). */
export function mapFetchError(e: unknown): WireErrorKind {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  const code = codeOf(e);
  if (DNS.test(code)) return 'dns';
  if (TIMEOUT.test(code)) return 'timeout';
  if (CONNECT.test(code)) return 'connect';
  if (RESET.test(code)) return 'reset';
  if (TLS.test(code)) return 'tls';
  const message = e instanceof Error ? e.message : '';
  if (/redirect/i.test(message)) return 'redirect';
  return 'other';
}
