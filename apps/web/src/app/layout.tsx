import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import './globals.css';
import { app } from '../server/access';
import { currentActor } from '../server/session';
import { EnvLabel } from '../ui/EnvLabel';
import { siteDescription, siteFooter } from '../ui/env-copy';
import { PUBLISHER_NAV_LABEL } from '../lib/publisher-copy';

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
  return (
    <html lang="en">
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
                <li>
                  <Link href="/discover">Find articles</Link>
                </li>
                {actor?.kind === 'buyer' ? (
                  <li>
                    <Link href="/library">My library</Link>
                  </li>
                ) : null}
                {actor?.kind === 'publisher' ? (
                  <li>
                    <Link href="/publisher">{PUBLISHER_NAV_LABEL}</Link>
                  </li>
                ) : null}
                {actor?.kind === 'operator' ? (
                  <li>
                    <Link href="/ops">Operations</Link>
                  </li>
                ) : null}
                <li>
                  <Link href="/help/payment">Help</Link>
                </li>
                {actor === null ? (
                  <li>
                    <Link href="/signin">Sign in</Link>
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
        </footer>
      </body>
    </html>
  );
}
