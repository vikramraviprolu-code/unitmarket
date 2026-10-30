'use client';
import { useState } from 'react';
import { postJson } from '../lib/client-api';
import type { Skin } from '../lib/skin';
import { SKINS } from '../lib/skin';
import {
  APPEARANCE_LEGEND,
  APPEARANCE_SAVE_FAILED,
  APPEARANCE_SAVING,
  SKIN_LABELS,
} from '../lib/appearance-copy';

// Footer control (SKIN-A). It works signed out: the route sets the um_skin cookie, then the page reloads
// so the server renders the chosen skin on first paint. Nothing is kept in the browser's storage.
export function AppearanceControl({ skin }: { skin: Skin }) {
  const [selected, setSelected] = useState(skin);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function choose(next: Skin) {
    if (next === selected || busy) return;
    const before = selected;
    setSelected(next);
    setBusy(true);
    setFailed(false);
    try {
      const res = await postJson('/api/appearance', { skin: next });
      if (!res.ok) throw new Error('refused');
      window.location.reload();
    } catch {
      setSelected(before);
      setBusy(false);
      setFailed(true);
    }
  }

  return (
    <fieldset className="appearance" data-testid="appearance">
      <legend>{APPEARANCE_LEGEND}</legend>
      {SKINS.map((s) => (
        <label key={s} className="radio">
          <input
            type="radio"
            name="skin"
            value={s}
            checked={s === selected}
            disabled={busy}
            onChange={() => void choose(s)}
          />
          <span>{SKIN_LABELS[s]}</span>
        </label>
      ))}
      <p className="hint" role="status">
        {busy ? APPEARANCE_SAVING : ''}
      </p>
      {failed ? (
        <p className="warn-text" role="alert">
          {APPEARANCE_SAVE_FAILED}
        </p>
      ) : null}
    </fieldset>
  );
}
