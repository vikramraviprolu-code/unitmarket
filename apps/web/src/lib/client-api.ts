'use client';
// Browser side of the JSON API. The CSRF token comes from the sign-in answer and lives in
// sessionStorage for this tab only; the session cookie itself is HttpOnly and never readable here.

const CSRF_KEY = 'um_csrf';

export function rememberCsrf(token: string): void {
  try {
    window.sessionStorage.setItem(CSRF_KEY, token);
  } catch {
    /* private mode: the user signs in again */
  }
}

export function readCsrf(): string {
  try {
    return window.sessionStorage.getItem(CSRF_KEY) ?? '';
  } catch {
    return '';
  }
}

export function remember(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function recall(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export interface ApiOk<T> {
  ok: true;
  status: number;
  data: T;
}
export interface ApiFail {
  ok: false;
  status: number;
  code: string;
  message: string;
}

// withRoute error bodies are { error: { code, message, support_code } }.
function failure(status: number, json: Record<string, unknown>): ApiFail {
  const e = (json['error'] ?? {}) as Record<string, unknown>;
  const code = typeof e['code'] === 'string' ? e['code'] : 'error';
  const message =
    typeof e['message'] === 'string' ? e['message'] : 'Something went wrong. Please try again.';
  const support = typeof e['support_code'] === 'string' ? ` (reference ${e['support_code']})` : '';
  return { ok: false, status, code, message: `${message}${status >= 500 ? support : ''}` };
}

export async function postJson<T>(
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<ApiOk<T> | ApiFail> {
  try {
    // eslint-disable-next-line no-restricted-globals -- same-origin call from the browser to this app's own JSON API; S2 targets payment network clients
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrf(), ...extra },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    return failure(res.status, json);
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'network',
      message: 'We could not reach the server. Check your connection and try again.',
    };
  }
}

export async function getJson<T>(path: string): Promise<ApiOk<T> | ApiFail> {
  try {
    // eslint-disable-next-line no-restricted-globals -- same-origin call from the browser to this app's own JSON API; S2 targets payment network clients
    const res = await fetch(path, { credentials: 'same-origin' });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    return failure(res.status, json);
  } catch {
    return { ok: false, status: 0, code: 'network', message: 'We could not reach the server.' };
  }
}
