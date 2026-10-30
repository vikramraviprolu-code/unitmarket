import Link from 'next/link';
import { app } from '../server/access';
import { formatMinor } from '../lib/format';
import { HarbourScene } from '../ui/HarbourScene';

export default async function Home() {
  const a = await app();
  const offers = await a.engine.listOffers();
  return (
    <>
      <HarbourScene />
      <h1>Buy just the article you need</h1>
      <p className="lede">
        Pay once for one article, with a clear price and five days of access. No subscription.
      </p>
      <div className="grid-2">
        <section className="card" aria-labelledby="have-link">
          <h2 id="have-link">I have an article link</h2>
          <p>Open the publisher's offer and see the price before you decide.</p>
          <ul>
            {offers.slice(0, 4).map((o) => (
              <li key={o.offer_id}>
                <Link href={`/o/${o.publisher_slug}/${o.offer_code}`}>{o.title}</Link>{' '}
                <span className="muted">
                  from {formatMinor(Math.min(...o.options.map((x) => x.price_minor)), o.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card" aria-labelledby="find">
          <h2 id="find">Find articles for my need</h2>
          <p>Tell us what you need and your ceiling. You choose; we only suggest.</p>
          <div className="actions">
            <Link className="btn btn-primary" href="/discover">
              Find articles
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
