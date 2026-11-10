'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import { DOMAIN_REMOVE_BUTTON, importErrorText } from '../../../lib/web-import-copy';

// DOMAIN-PROOF-2 (D-116): the publisher removes one of its own addresses. The body is the host and nothing else.
export function RemoveAddress({ host }: { host: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    setProblem(null);
    const r = await postJson('/api/publisher/import/domains/remove', { host });
    setBusy(false);
    if (!r.ok) {
      setProblem(r.status === 401 ? 'Please sign in again.' : importErrorText(r.code));
      return;
    }
    router.refresh();
  }
  return (
    <>
      <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>
        {DOMAIN_REMOVE_BUTTON}
      </button>
      {problem ? <span role="alert"> {problem}</span> : null}
    </>
  );
}
