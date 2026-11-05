'use client';
import { useState } from 'react';
import { getJson } from '../../lib/client-api';
import { csvDownload } from '../../lib/transactions-view';
import { hrefWith } from '../../lib/filter-bar-view';
import { SPENDING_EXPORT_LABEL } from '../../lib/buyer-spending-view';
import './buyer.css';

// INT-BUY / BUY.4: the CSV button of the Spending page. It asks GET /api/buyer/orders/export for the same filter
// as the list and saves the text as a file in the browser. The route, not this file, decides what the file holds.
export function SpendingExport({ query }: { query: Record<string, string> }) {
  const [note, setNote] = useState('');
  async function download(): Promise<void> {
    setNote('Preparing the file.');
    // The page cursor is never part of an export: the file is the whole result.
    const { cursor, ...rest } = query;
    void cursor;
    const r = await getJson<{ filename: string; csv: string; truncated: boolean }>(
      hrefWith('/api/buyer/orders/export', rest),
    );
    if (!r.ok) {
      setNote('The file could not be made. Try again in a moment.');
      return;
    }
    const file = csvDownload(r.data);
    const href = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
    const a = document.createElement('a');
    a.href = href;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(href);
    setNote(file.note ?? 'The file was downloaded.');
  }
  return (
    <div className="actions">
      <button type="button" className="btn" onClick={() => void download()}>
        {SPENDING_EXPORT_LABEL}
      </button>
      <p role="status" aria-live="polite" className="txn-note" data-testid="spending-export-status">
        {note}
      </p>
    </div>
  );
}
