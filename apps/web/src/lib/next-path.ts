// GATE35 D8: the sign-in redirect target and the discover helpers. Pure so a unit test can pin them.

/** A same-site path only: no scheme, no host, no backslash; the query is limited to the allow-listed characters. */
export function safeNext(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  return s !== undefined && /^\/(?![/\\])[A-Za-z0-9._~\-/[\]?=&%]*$/.test(s) ? s : '/';
}

const MAX_NEED_IN_URL = 300;

/** The sign in link from /discover. A typed need rides in next= so it survives sign in. */
export function discoverSignInHref(need: string): string {
  const t = Array.from(need.trim()).slice(0, MAX_NEED_IN_URL).join('');
  if (t === '') return '/signin?next=/discover';
  try {
    // encodeURIComponent leaves ! ' ( ) * alone; the allow list does not, so they are encoded too.
    const enc = encodeURIComponent(t).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `/signin?next=${encodeURIComponent(`/discover?need=${enc}`)}`;
  } catch {
    return '/signin?next=/discover'; // a lone surrogate cannot be encoded: keep the plain link
  }
}

/** A need that arrives in the URL runs once for a signed in buyer. */
export const shouldAutoSearch = (need: string, signedIn: boolean): boolean =>
  signedIn && need.trim() !== '';
