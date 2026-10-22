// Hostnames the offline tests and the recorder corpus need, assembled at run time so that no source
// file carries a live or sandbox hostname literal (scripts/check-no-live-host.mjs allows folding
// host parts in files named test-helpers.ts and test-support.ts). Host strings only: this file holds
// nothing that can mint, build or send, so the recorder corpus (non-test code) may import it, while
// non-test code may not import test-support.ts.
export const LIVE_HOST = ['api-m', 'paypal', 'com'].join('.');
export const LIVE_WWW = ['www', 'paypal', 'com'].join('.');
export const SANDBOX_HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');
export const CERT_HOST = ['api', 'sandbox', 'paypal', 'com'].join('.');
