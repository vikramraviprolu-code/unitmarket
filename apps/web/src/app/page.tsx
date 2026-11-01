import { app } from '../server/access';
import { currentActor } from '../server/session';
import { formatMinor, optionLabel } from '../lib/format';
import { Hero } from '../ui/Hero';
import { OfferTile } from '../ui/OfferTile';
import { RoleDoors } from '../ui/RoleDoors';
import './auth.css';

export default async function Home() {
  const a = await app();
  const offers = await a.engine.listOffers();
  const actor = await currentActor();
  const kind =
    actor?.kind === 'buyer' || actor?.kind === 'publisher' || actor?.kind === 'operator'
      ? actor.kind
      : null;
  return (
    <>
      <Hero>
        <h1>Buy just the article you need</h1>
        <p className="lede">
          Pay once for one article, with a clear price and five days of access. No subscription.
        </p>
        <form action="/discover" method="get">
          <label htmlFor="home-need">What do you need?</label>
          <div className="search-pill">
            <input id="home-need" name="need" type="text" maxLength={2000} />
            <button className="btn btn-primary" type="submit">
              Find articles
            </button>
          </div>
        </form>
      </Hero>
      <RoleDoors actorKind={kind} />
      {offers.length > 0 ? (
        <section aria-labelledby="shelf">
          <h2 id="shelf" className="shelf-title">
            Open an article
          </h2>
          <p className="muted">See the price before you decide. You choose; we only suggest.</p>
          <ul className="shelf">
            {offers.slice(0, 6).map((o) => {
              const cheapest = [...o.options].sort((x, y) => x.price_minor - y.price_minor)[0];
              return (
                <OfferTile
                  key={o.offer_id}
                  href={`/o/${o.publisher_slug}/${o.offer_code}`}
                  title={o.title}
                  publisher={o.publisher}
                  priceText={formatMinor(cheapest?.price_minor ?? 0, o.currency)}
                  tag={cheapest ? optionLabel(cheapest.option) : ''}
                />
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
