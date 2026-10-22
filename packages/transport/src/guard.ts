import { CERT_HOST_SUFFIX, CERT_PATH_PREFIX, ID_PATTERN, PATHS, SANDBOX_API } from './endpoints';
import type { OutboundRequest } from '@umsbx/contracts';

// Egress guard shared by the dry-run and the sandbox transport (architecture 7 point 6, nfr.md
// P1 and SOP 18). Pure: no I/O. A refusal carries no detail so nothing about the rule leaks.

const SANDBOX_HOST = new URL(SANDBOX_API).hostname;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CERT_HOST_RE = new RegExp(`^[a-z0-9-]+(\\.[a-z0-9-]+)*${escapeRe(CERT_HOST_SUFFIX)}$`);
const CERT_PATH_RE = new RegExp(`^${escapeRe(CERT_PATH_PREFIX)}[A-Za-z0-9._-]+$`);

const PATH_RES = Object.fromEntries(
  Object.entries(PATHS).map(([op, spec]) => [
    op,
    new RegExp(`^${escapeRe(spec.template).replace('\\{id\\}', ID_PATTERN)}$`),
  ]),
);

export type GuardResult = { ok: true; url: URL } | { ok: false; by: 'egress' };
const refuse = (): GuardResult => ({ ok: false, by: 'egress' });

export function guard(r: OutboundRequest, kind: 'dryrun' | 'sandbox'): GuardResult {
  void kind; // both transports apply the identical rules
  const spec = PATHS[r.operation];
  if (!spec || r.method !== spec.method) return refuse();

  const raw = r.path;
  // printable ASCII only; no query, fragment, percent-encoding or backslash anywhere
  if (typeof raw !== 'string' || !/^[\x21-\x7e]+$/.test(raw) || /[?#%\\]/.test(raw))
    return refuse();

  let url: URL;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      url = new URL(raw);
    } catch {
      return refuse();
    }
  } else if (raw.startsWith('/') && !raw.startsWith('//')) {
    url = new URL(raw, SANDBOX_API);
  } else {
    return refuse();
  }

  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return refuse();
  if (url.port !== '' || url.search !== '' || url.hash !== '') return refuse();
  if (/(^|\/)\.\.?(\/|$)/.test(url.pathname) || /(^|\/)\.\.?(\/|$)/.test(raw)) return refuse();

  if (r.operation === 'fetch_webhook_cert') {
    // Only the certificate fetch may leave the API host, and only to a sandbox host under the
    // certificate path. The path must be given as an absolute URL.
    if (raw.startsWith('/')) return refuse();
    if (!CERT_HOST_RE.test(url.hostname)) return refuse();
    if (!CERT_PATH_RE.test(url.pathname)) return refuse();
    return { ok: true, url };
  }

  if (url.hostname !== SANDBOX_HOST) return refuse();
  const re = PATH_RES[r.operation];
  if (!re || !re.test(url.pathname)) return refuse();
  return { ok: true, url };
}
