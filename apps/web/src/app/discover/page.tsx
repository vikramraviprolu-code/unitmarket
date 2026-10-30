import Link from 'next/link';
import type { Metadata } from 'next';
import { app } from '../../server/access';
import { currentActor } from '../../server/session';
import { DiscoverForm } from './DiscoverForm';
import { StatusBanner } from '../../ui/StatusBanner';
import { formatMinor } from '../../lib/format';
import { browseEntries } from '../../lib/buyer-copy';

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
  const ai = await a.engine.aiEnabled();
  if (!ai) {
    // READINESS: ai_enabled off means catalogue-only. No agent, no model.
    const offers = await a.engine.listOffers();
    return (
      <>
        <h1>Find articles</h1>
        <StatusBanner tone="warn" title="Finding articles for a need is paused">
          You can still browse the catalogue and open any article.
        </StatusBanner>
        <ul>
          {offers.map((o) => (
            <li key={o.offer_id}>
              <Link href={`/o/${o.publisher_slug}/${o.offer_code}`}>{o.title}</Link>{' '}
              <span className="muted">
                from {formatMinor(Math.min(...o.options.map((x) => x.price_minor)), o.currency)}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  const offers = await a.engine.listOffers();
  const browse = browseEntries(offers);
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
