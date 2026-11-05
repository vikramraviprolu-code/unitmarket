'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { breadcrumbFor } from '../../lib/breadcrumb';

// INT-UI0 / UI0.1: where the visitor is. The last crumb is the current page and is not a link. Public pages
// have no trail, so nothing is drawn for them.
export function Breadcrumb() {
  const crumbs = breadcrumbFor(usePathname() ?? '');
  if (crumbs.length === 0) return null;
  return (
    <nav className="shell-crumbs" data-testid="shell-breadcrumb" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((c) => (
          <li key={c.label} aria-current={c.href === null ? 'page' : undefined}>
            {c.href === null ? c.label : <Link href={c.href}>{c.label}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
