'use client';
import { useState } from 'react';
import { postJson } from '../../lib/client-api';
import { ErrorState } from '../../ui/ErrorState';

export function OpenButton({
  entitlementId,
  mode,
}: {
  entitlementId: string;
  mode: 'read' | 'download';
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    setError(null);
    const r = await postJson<{ url: string }>(
      `/api/library/${encodeURIComponent(entitlementId)}/link`,
      {},
    );
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    window.location.assign(`${r.data.url}?mode=${mode}`);
  }
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => void open()} disabled={busy}>
        {mode === 'read' ? 'Read online' : 'Download'}
      </button>
      {error ? <ErrorState title="Could not open">{error}</ErrorState> : null}
    </>
  );
}
