// FIX-PAY2 LOW: GET /checkout/return captures money (and, in dry run, plays the approval), so a
// cross-site <img>, <iframe> or fetch must not be able to fire it. The browser sends Sec-Fetch-*
// headers it controls and a page cannot forge: a page navigation has dest "document" and mode
// "navigate". That is true for the buyer coming back from PayPal (a cross-site navigation), from
// our own dry-run page and from a typed address. An image, a frame, a script, a fetch or a
// prefetch is something else. Such a request is shown a button instead; the button is a GET form,
// which the browser sends as a page navigation. A client that sends no Sec-Fetch headers at all
// cannot pass (server actions are barred by check:routes, so there is no POST fallback).
export function isBuyerNavigation(get: (name: string) => string | null): boolean {
  if (get('sec-fetch-dest') !== 'document' || get('sec-fetch-mode') !== 'navigate') return false;
  const purpose = get('sec-purpose') ?? get('purpose');
  return !(purpose !== null && /prefetch|prerender/i.test(purpose));
}
