'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PERSONA_WORD, activeTabId, visibleTabs, type ShellPersona } from '../../lib/shell-tabs';

// INT-UI0 / UI0.1: the bottom tab bar of a phone. The same ready tabs as the top row; shell.css shows it only
// under 640px and hides the top row there, so a screen reader meets one list at a time.
export function PhoneBar({ persona }: { persona: ShellPersona }) {
  const active = activeTabId(persona, usePathname() ?? '');
  return (
    <nav
      className="shell-phonebar"
      data-testid="shell-phonebar"
      aria-label={`${PERSONA_WORD[persona]} pages, bottom bar`}
    >
      <ul>
        {visibleTabs(persona).map((t) => (
          <li key={t.id}>
            <Link href={t.href} aria-current={t.id === active ? 'page' : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
