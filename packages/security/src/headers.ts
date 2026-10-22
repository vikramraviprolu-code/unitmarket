// Security headers (architecture 9.8). The nonce comes from Ids.nonce() per response.
const NONCE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export function securityHeaders(nonce: string): Record<string, string> {
  if (!NONCE_SHAPE.test(nonce)) throw new Error('securityHeaders: bad nonce');
  return {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "frame-ancestors 'none'",
      "form-action 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  };
}
