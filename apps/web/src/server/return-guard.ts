// FIX-PAY2 LOW: GET /checkout/return captures money (and, in dry run, plays the approval), so a
// cross-site <img>, <iframe> or fetch must not be able to fire it. The browser sends Sec-Fetch-*
// headers it controls and a page cannot forge: a page navigation has dest "document" and mode
// "navigate". That is true for the buyer coming back from PayPal (a cross-site navigation), from
// our own dry-run page and from a typed address. An image, a frame, a script, a fetch or a
// prefetch is something else. A request with no such headers (an old client, a script) is asked to
// confirm with a button, which is a POST (a server action, checked by Next for its origin).
export function isBuyerNavigation(get: (name: string) => string | null): boolean {
  if (get('sec-fetch-dest') !== 'document' || get('sec-fetch-mode') !== 'navigate') return false;
  const purpose = get('sec-purpose') ?? get('purpose');
  return !(purpose !== null && /prefetch|prerender/i.test(purpose));
}
