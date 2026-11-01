'use client';
import { useState, useSyncExternalStore } from 'react';
import { postJson } from '../lib/client-api';
import type { Skin } from '../lib/skin';
import { SKINS, skinFromCookie } from '../lib/skin';
import {
  APPEARANCE_LEGEND,
  APPEARANCE_SAVE_FAILED,
  SKIN_LABELS,
  appearanceApplied,
} from '../lib/appearance-copy';

// The Appearance switch in the site header (WEB-THEME): both skins one click away on every page, 44px targets,
// keyboard reachable. Same route and same words as the footer control; the skin is applied to <html> in place
// (no reload, so the button keeps focus) and announced in a status region. The two controls read the skin from
// the <html> attribute, so they never disagree. Nothing is kept in the browser's storage.
function subscribe(onChange: () => void): () => void {
  const watcher = new MutationObserver(onChange);
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] });
  return () => watcher.disconnect();
}
const readSkin = (): Skin =>
  skinFromCookie(document.documentElement.getAttribute('data-skin') ?? undefined);

export function AppearanceSwitch({ skin }: { skin: Skin }) {
  const active = useSyncExternalStore(subscribe, readSkin, () => skin);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');

  async function choose(next: Skin) {
    if (next === active || busy) return;
    setBusy(true);
    setSaid('');
    try {
      const res = await postJson('/api/appearance', { skin: next });
      if (!res.ok) throw new Error('refused');
      document.documentElement.setAttribute('data-skin', next);
      setSaid(appearanceApplied(SKIN_LABELS[next]));
    } catch {
      setSaid(APPEARANCE_SAVE_FAILED);
    }
    setBusy(false);
  }

  return (
    <div
      className="skin-switch"
      role="group"
      aria-label={APPEARANCE_LEGEND}
      data-testid="appearance-header"
    >
      {SKINS.map((s) => {
        const [first = '', ...rest] = SKIN_LABELS[s].split(' ');
        return (
          <button key={s} type="button" aria-pressed={s === active} onClick={() => void choose(s)}>
            <span className="skin-w">{`${first} `}</span>
            {rest.join(' ')}
          </button>
        );
      })}
      <span
        className="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="appearance-header-status"
      >
        {said}
      </span>
    </div>
  );
}
