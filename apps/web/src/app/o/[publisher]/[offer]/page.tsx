import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor } from '../../../../server/session';
import { buyerFactsLine } from '../../../../lib/offer-copy';
import { optionPrices } from '../../../../lib/buyer-price';
import { buyerDisplay } from '../../../../server/buyer-display';
import { OfferFlow } from './OfferFlow';

export const metadata: Metadata = { title: 'Offer' };

export default async function OfferPageRoute({
  params,
}: {
  params: Promise<{ publisher: string; offer: string }>;
}) {
  const { publisher, offer } = await params;
  const a = await app();
  const o = await a.engine.offerPage({ publisher, offer });
  if (o === null) notFound();
  const actor = await currentActor();
  // MC2-L5: the option prices in the buyer's currency (about, with the rate date) beside the binding amount.
  const display = await buyerDisplay(a.engine, actor, { currencies: [o.currency] });
  return (
    <>
      <p className="muted">{o.publisher}</p>
      <h1>{o.title}</h1>
      <p className="lede">{o.abstract}</p>
      <p className="muted" data-testid="offer-article-facts">
        {buyerFactsLine({ language: o.language, bytes: o.bytes })}
      </p>
      <OfferFlow
        offer={o}
        signedIn={actor?.kind === 'buyer'}
        prices={optionPrices(o, display.view)}
        days={await a.engine.platformAccessDays()}
      />
    </>
  );
}
