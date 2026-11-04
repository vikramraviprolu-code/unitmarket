import Link from 'next/link';
import type { Metadata } from 'next';
import { app } from '../../server/access';
import { currentActor } from '../../server/session';
import { DiscoverForm } from './DiscoverForm';
import { StatusBanner } from '../../ui/StatusBanner';
import { buyerDisplay } from '../../server/buyer-display';
import { fromLead } from '../../lib/buyer-price';
import { browseEntries } from '../../lib/buyer-copy';
import { discoverForNonBuyer } from '../../lib/nav';

export const metadata: Metadata = { title: 'Find articles' };

export default async function Discover({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const raw = q['need'];
  const initialNeed = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 2000) ?? '';
  const a = await app();
  const actor = await currentActor();
  // GATE35 D7: a publisher or operator is not asked to "Sign in first": they are told this is a buyer screen.
  if (actor?.kind === 'publisher' || actor?.kind === 'operator') {
    const other = discoverForNonBuyer(actor.kind);
    return (
      <>
        <h1>Find articles</h1>
        <StatusBanner tone="info" title="This page is for buyers">
          <span data-testid="discover-non-buyer">{other.line}</span>{' '}
          <Link href={other.href}>{other.label}</Link>
        </StatusBanner>
      </>
    );
  }
  const ai = await a.engine.aiEnabled();
  if (!ai) {
    // READINESS: ai_enabled off means catalogue-only. No agent, no model.
    const offers = await a.engine.listOffers();
    const display = await buyerDisplay(a.engine, actor, {
      currencies: offers.map((o) => o.currency),
    });
    return (
      <>
        <h1>Find articles</h1>
        <StatusBanner tone="warn" title="Finding articles for a need is paused">
          You can still browse the catalogue and open any article.
        </StatusBanner>
        <ul>
          {offers.map((o) => {
            const price = display.view({
              currency: o.currency,
              minor: Math.min(...o.options.map((x) => x.price_minor)),
            });
            return (
              <li key={o.offer_id}>
                <Link href={`/o/${o.publisher_slug}/${o.offer_code}`}>{o.title}</Link>{' '}
                <span className="muted">{fromLead(price)}</span>
                {price.binding !== null ? <span className="muted"> · {price.binding}</span> : null}
              </li>
            );
          })}
        </ul>
      </>
    );
  }
  const offers = await a.engine.listOffers();
  // MC2-L5: the browse list shows each price in the buyer's currency (about, with the rate date) beside the
  // binding seller amount.
  const display = await buyerDisplay(a.engine, actor, {
    currencies: offers.map((o) => o.currency),
  });
  const browse = browseEntries(offers, display.view);
  const rights = offers.map((o) => o.rights);
  return (
    <>
      <DiscoverForm
        signedIn={actor?.kind === 'buyer'}
        browse={browse}
        rights={rights}
        initialNeed={initialNeed}
      >
        <h1>Find articles for my need</h1>
        <p className="lede">Describe what you need and what you can pay. You pick the article.</p>
      </DiscoverForm>
    </>
  );
}
