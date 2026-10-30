'use client';
import { useState } from 'react';
import { postJson } from '../lib/client-api';
import { SIGN_OUT_LABEL } from '../lib/nav';

// FIX-FLOW D1. A header control for a signed in actor. The route ends this session and clears the cookie;
// the tab's CSRF token is dropped with it. If the request fails the actor stays signed in and is told.
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function out() {
    setBusy(true);
    setFailed(false);
    const r = await postJson('/api/session/signout', {});
    if (!r.ok) {
      setBusy(false);
      setFailed(true);
      return;
    }
    try {
      window.sessionStorage.clear();
    } catch {
      /* private mode: nothing was kept */
    }
    window.location.assign('/');
  }
  return (
    <>
      <button type="button" className="btn" onClick={() => void out()} aria-disabled={busy}>
        {SIGN_OUT_LABEL}
      </button>
      <span role="status" className="muted">
        {failed ? 'We could not sign you out. Please try again.' : ''}
      </span>
    </>
  );
}
