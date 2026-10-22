// Security headers for pages (SOP 10, architecture 9.8). Same values as securityHeaders() in
// @umsbx/security, kept here as plain strings so the middleware stays small; a test asserts the two
// agree. Pages are never cached: they carry session-dependent money state.
export function pageHeaders(nonce: string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('pageHeaders: bad nonce');
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
    'Cache-Control': 'private, no-store',
  };
}
