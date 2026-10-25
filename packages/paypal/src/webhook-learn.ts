// The learn path's one question to PayPal's side (CO-1d, D-038): what does the certificate named by a
// delivery's `paypal-cert-url` header look like? It reads that one header and nothing else of the
// delivery (not the body, the signature, the transmission id or any other header), hands the URL to
// the certificate source's `inspect`, and returns the facts or nothing. It verifies nothing, trusts
// nothing and never throws: whatever goes wrong is `nothing`, and the route answers 503 either way.
import type { CertificateFacts, CertificateSource, InspectResult } from './webhook-cert';

const H_CERT = 'paypal-cert-url';
const MAX_CERT_URL_CHARS = 512; // the same bound as webhook-verify.ts

export type LearnResult =
  | { kind: 'facts'; facts: CertificateFacts }
  | { kind: 'nothing'; why: 'no_url' | 'unsupported' | 'unavailable' };

/** A certificate source that can describe a certificate (the production source can; a test stand-in may not). */
export type Describer = CertificateSource & {
  inspect?: (url: string) => Promise<InspectResult>;
};

/** The single, non-empty, string `paypal-cert-url` header (any case), or null. */
function certUrlOf(headers: Record<string, unknown>): string | null {
  let found: string | null = null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== H_CERT) continue;
    if (found !== null) return null; // repeated: ambiguous, so nothing
    if (typeof value !== 'string' || value === '' || value.length > MAX_CERT_URL_CHARS) return null;
    found = value;
  }
  return found;
}

export async function learnWebhookCertificate(
  source: Describer,
  headers: Record<string, string>,
): Promise<LearnResult> {
  const url = certUrlOf(headers);
  if (url === null) return { kind: 'nothing', why: 'no_url' };
  if (typeof source.inspect !== 'function') return { kind: 'nothing', why: 'unsupported' };
  try {
    const r = await source.inspect(url);
    return r.kind === 'ok'
      ? { kind: 'facts', facts: r.facts }
      : { kind: 'nothing', why: 'unavailable' };
  } catch {
    return { kind: 'nothing', why: 'unavailable' };
  }
}
