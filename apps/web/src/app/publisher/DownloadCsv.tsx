'use client';
import { useState } from 'react';
import { getJson } from '../../lib/client-api';
import { EXPORT_FAILED, EXPORT_TRUNCATED } from '../../lib/publisher-e1-copy';

// PUB-E1: a button that fetches one CSV file from the export route and saves it. The route answers JSON
// ({ filename, csv, truncated }); the file is made in the browser from that text. Only the kind of file is
// sent. Nothing is stored and no address leaves the page.
export function DownloadCsv({
  href,
  label,
  testId,
}: {
  href: string;
  label: string;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setNote(null);
    const res = await getJson<{ filename: string; csv: string; truncated: boolean }>(href);
    setBusy(false);
    if (!res.ok) {
      setNote(EXPORT_FAILED);
      return;
    }
    const url = URL.createObjectURL(new Blob([res.data.csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = res.data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (res.data.truncated) setNote(EXPORT_TRUNCATED);
  }

  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void download()}
        data-testid={testId}
      >
        {label}
      </button>
      <span aria-live="polite" className="muted" data-testid={`${testId}-note`}>
        {note}
      </span>
    </>
  );
}
