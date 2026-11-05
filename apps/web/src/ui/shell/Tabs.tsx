'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  PERSONA_WORD,
  activeTabId,
  subTabsFor,
  subTabsLabel,
  visibleTabs,
  type ShellPersona,
} from '../../lib/shell-tabs';

// INT-UI0 / UI0.1: the lasting tabs of one persona. Plain links, so they work with the keyboard, with a
// screen reader and with scripts off (the current page is read from the path on the server render too). Only
// tabs whose page exists are listed (the `ready` flag in lib/shell-tabs.ts). Sellers and Controls add a
// second row of section tabs for the pages kept at their old URLs.
export function Tabs({ persona }: { persona: ShellPersona }) {
  const path = usePathname() ?? '';
  const active = activeTabId(persona, path);
  const sub = subTabsFor(persona, path);
  const subLabel = subTabsLabel(persona, path);
  return (
    <>
      <nav
        className="shell-tabs"
        data-testid="shell-tabs"
        aria-label={`${PERSONA_WORD[persona]} pages`}
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
      {sub !== null && subLabel !== null ? (
        <nav
          className="shell-subtabs"
          data-testid="shell-subtabs"
          aria-label={`${subLabel} sections`}
        >
          <ul>
            {sub.map((s) => (
              <li key={s.href}>
                <Link href={s.href} aria-current={s.current ? 'page' : undefined}>
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </>
  );
}
