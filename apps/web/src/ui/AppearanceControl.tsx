'use client';
import { useEffect, useState } from 'react';
import { postJson } from '../lib/client-api';
import type { Skin } from '../lib/skin';
import { SKINS, skinFromCookie } from '../lib/skin';
import {
  APPEARANCE_LEGEND,
  APPEARANCE_SAVE_FAILED,
  APPEARANCE_SAVING,
  SKIN_LABELS,
  appearanceApplied,
} from '../lib/appearance-copy';

// Footer control (SKIN-A). It works signed out: the route sets the um_skin cookie, then the skin is applied
// to <html> in place (FIX-FLOW D8: a reload dropped keyboard focus) and announced in the status line. The
// server renders the chosen skin on first paint from the cookie. Nothing is kept in the browser's storage.
export function AppearanceControl({ skin }: { skin: Skin }) {
  const [selected, setSelected] = useState(skin);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [said, setSaid] = useState('');

  // WEB-THEME: the header switch changes <html data-skin> too, so the radios follow that attribute.
  useEffect(() => {
    const watcher = new MutationObserver(() => {
      setSelected(skinFromCookie(document.documentElement.getAttribute('data-skin') ?? undefined));
    });
    watcher.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-skin'],
    });
    return () => watcher.disconnect();
  }, []);

  async function choose(next: Skin) {
    if (next === selected || busy) return;
    const before = selected;
    setSelected(next);
    setBusy(true);
    setFailed(false);
    setSaid('');
    try {
      const res = await postJson('/api/appearance', { skin: next });
      if (!res.ok) throw new Error('refused');
      // FIX-FLOW D8: no reload, so the radio keeps focus. The server renders the same attribute from the
      // cookie on the next page, so a later visit agrees with what is shown now.
      document.documentElement.setAttribute('data-skin', next);
      setBusy(false);
      setSaid(appearanceApplied(SKIN_LABELS[next]));
    } catch {
      setSelected(before);
      setBusy(false);
      setSaid('');
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
            onChange={() => void choose(s)}
          />
          <span>{SKIN_LABELS[s]}</span>
        </label>
      ))}
      <p className="hint" role="status" aria-live="polite" data-testid="appearance-status">
        {busy ? APPEARANCE_SAVING : said}
      </p>
      {failed ? (
        <p className="warn-text" role="alert">
          {APPEARANCE_SAVE_FAILED}
        </p>
      ) : null}
    </fieldset>
  );
}
