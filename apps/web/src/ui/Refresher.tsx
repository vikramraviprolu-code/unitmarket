'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Re-reads the server-rendered page every few seconds while it is visible, so a status that changed
// elsewhere (a refund the operator just made) arrives in the page's aria-live region without a reload
// (A11Y-4). The page computes nothing: it prints what the server read from stored state.
export function Refresher({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
