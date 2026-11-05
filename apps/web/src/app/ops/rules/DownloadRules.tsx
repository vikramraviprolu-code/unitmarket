'use client';
import { useState } from 'react';
import { getJson } from '../../../lib/client-api';
import { EXPORT_FAILED, EXPORT_TRUNCATED, RULES_EXPORT_BUTTON } from '../../../lib/ops-rules-copy';

// BR-6: a button that fetches the history file from GET /api/ops/rules/export and saves it. The route answers
// JSON ({ filename, csv, truncated }); the file is made in the browser from that text. Nothing is sent and
// nothing is stored. This is a read: it adds no setting.
export function DownloadRules() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setNote(null);
    const res = await getJson<{ filename: string; csv: string; truncated: boolean }>(
      '/api/ops/rules/export',
    );
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
        data-testid="rules-export"
      >
        {RULES_EXPORT_BUTTON}
      </button>
      <span aria-live="polite" className="muted" data-testid="rules-export-note">
        {note}
      </span>
    </>
  );
}
