import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
import { app } from '../server/access';
import { currentActor } from '../server/session';
import { AppearanceControl } from '../ui/AppearanceControl';
import { EnvLabel } from '../ui/EnvLabel';
import { siteDescription, siteFooter } from '../ui/env-copy';
import { SKIN_COOKIE, skinFromCookie } from '../lib/skin';
import { LEGAL_NAV } from '../lib/legal-copy';
import { navItems } from '../lib/nav';
import { SignOutButton } from '../ui/SignOutButton';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const a = await app();
  return {
    title: { default: 'UnitMarket', template: '%s | UnitMarket' },
    description: siteDescription(a.environment),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const a = await app();
  const actor = await currentActor();
  const nav = navItems(
    actor?.kind === 'buyer' || actor?.kind === 'publisher' || actor?.kind === 'operator'
      ? actor.kind
      : null,
  );
  const skin = skinFromCookie((await cookies()).get(SKIN_COOKIE)?.value);
  return (
    <html lang="en" data-skin={skin}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <div className="inner">
            <Link className="brand" href="/">
              UnitMarket
            </Link>
            <nav aria-label="Main">
              <ul>
                {nav.items.map((n) => (
                  <li key={n.href}>
                    <Link href={n.href}>{n.label}</Link>
                  </li>
                ))}
                {nav.sign_out ? (
                  <li>
                    <SignOutButton />
                  </li>
                ) : null}
              </ul>
            </nav>
            <span className="spacer" />
            <EnvLabel environment={a.environment} />
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">
          <p>{siteFooter(a.environment)}</p>
          <AppearanceControl skin={skin} />
          <nav aria-label="Legal">
            <ul>
              <li>
                <Link href="/legal/terms">{LEGAL_NAV.terms}</Link>
              </li>
              <li>
                <Link href="/legal/privacy">{LEGAL_NAV.privacy}</Link>
              </li>
              <li>
                <Link href="/legal/refunds">{LEGAL_NAV.refunds}</Link>
              </li>
              <li>
                <Link href="/legal/publisher-terms">{LEGAL_NAV['publisher-terms']}</Link>
              </li>
            </ul>
          </nav>
        </footer>
      </body>
    </html>
  );
}
