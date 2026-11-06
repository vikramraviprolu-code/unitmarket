import type { Metadata } from 'next';
import Link from 'next/link';
import {
  BUYER_CREATE,
  BUYER_LEDE,
  BUYER_LOST,
  BUYER_LOST_TITLE,
  BUYER_NEED_ITEMS,
  BUYER_NEED_TITLE,
  BUYER_NO_EMAIL,
  BUYER_SIGN_IN,
  BUYER_TITLE,
  HELP_PASSWORD_TITLE,
} from '../../lib/account-copy';
import { currentActor } from '../../server/session';
import { homeAudience } from '../../lib/buyer-home-view';
import { BuyerHome } from './BuyerHome';
import '../auth.css';

export const metadata: Metadata = { title: BUYER_TITLE };

// ID-ACCOUNTS: what a buyer needs, in plain words, and the two ways in. Public, no data read, no script.
// INT-BUY / BUY.5: a signed-in buyer gets Home in this place. A signed-out visitor, a seller or an operator still
// gets the public text below, unchanged (build note N4).
export default async function BuyerPage() {
  const actor = await currentActor();
  if (homeAudience(actor?.kind ?? null) === 'home' && actor?.kind === 'buyer')
    return <BuyerHome buyer_id={actor.buyer_id} />;
  return (
    <div className="auth-wrap-wide" data-testid="buyer-page">
      <header className="auth-head">
        <h1>{BUYER_TITLE}</h1>
        <p className="lede">{BUYER_LEDE}</p>
      </header>
      <div className="auth-panels auth-panels-two">
        <section className="auth-card" aria-labelledby="buyer-need">
          <h2 id="buyer-need">{BUYER_NEED_TITLE}</h2>
          <ol className="auth-steps">
            {BUYER_NEED_ITEMS.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ol>
          <p className="auth-note" data-testid="buyer-no-email">
            {BUYER_NO_EMAIL}
          </p>
        </section>
        <div className="auth-panels">
          <section className="auth-card" aria-label={BUYER_CREATE}>
            <div className="auth-actions">
              <Link className="btn btn-primary" href="/signup" data-testid="buyer-create">
                {BUYER_CREATE}
              </Link>
              <Link className="btn" href="/signin/buyer" data-testid="buyer-signin">
                {BUYER_SIGN_IN}
              </Link>
            </div>
          </section>
          <section className="auth-card" aria-labelledby="buyer-lost">
            <h2 id="buyer-lost">{BUYER_LOST_TITLE}</h2>
            <p>{BUYER_LOST}</p>
            <p>
              <Link className="auth-link" href="/help/password">
                {HELP_PASSWORD_TITLE}
              </Link>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
