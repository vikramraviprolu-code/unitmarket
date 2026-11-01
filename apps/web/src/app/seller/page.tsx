import type { Metadata } from 'next';
import Link from 'next/link';
import {
  SELLER_APPLY,
  SELLER_HOW,
  SELLER_HOW_TITLE,
  SELLER_LEDE,
  SELLER_PREPARE_ITEMS,
  SELLER_PREPARE_TITLE,
  SELLER_SIGN_IN,
  SELLER_STATUS,
  SELLER_TERMS_LINK,
  SELLER_TITLE,
} from '../../lib/account-copy';
import '../auth.css';

export const metadata: Metadata = { title: SELLER_TITLE };

// ID-ACCOUNTS: what a seller prepares, how an application is handled today (by hand, no email), and the three
// ways on: apply, check an application, sign in. Public, no data read, no script.
export default function SellerPage() {
  return (
    <div className="auth-wrap-wide" data-testid="seller-page">
      <header className="auth-head">
        <h1>{SELLER_TITLE}</h1>
        <p className="lede">{SELLER_LEDE}</p>
      </header>
      <div className="auth-panels auth-panels-two">
        <section className="auth-card" aria-labelledby="seller-prepare">
          <h2 id="seller-prepare">{SELLER_PREPARE_TITLE}</h2>
          <ol className="auth-steps">
            {SELLER_PREPARE_ITEMS.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ol>
          <p>
            <Link className="auth-link" href="/legal/publisher-terms">
              {SELLER_TERMS_LINK}
            </Link>
          </p>
        </section>
        <div className="auth-panels">
          <section className="auth-card" aria-label={SELLER_APPLY}>
            <div className="auth-actions">
              <Link className="btn btn-primary" href="/apply" data-testid="seller-apply">
                {SELLER_APPLY}
              </Link>
              <Link className="btn" href="/apply/status" data-testid="seller-status">
                {SELLER_STATUS}
              </Link>
              <Link className="btn" href="/signin/seller" data-testid="seller-signin">
                {SELLER_SIGN_IN}
              </Link>
            </div>
          </section>
          <section className="auth-card" aria-labelledby="seller-how">
            <h2 id="seller-how">{SELLER_HOW_TITLE}</h2>
            <p data-testid="seller-how">{SELLER_HOW}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
