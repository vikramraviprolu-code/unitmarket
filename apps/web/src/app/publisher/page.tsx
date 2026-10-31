import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import './pk-home.css';
import { app, salesTotals } from '../../server/access';
import { currentActor } from '../../server/session';
import { EmptyState } from '../../ui/EmptyState';
import { EnvLabel } from '../../ui/EnvLabel';
import { Chip, Section, StatTile } from '../../ui/publisher/kit';
import { HomeCard } from './HomeCard';
import {
  APPLIED_NOTICE,
  LINK_OFFERS,
  LINK_PAYOUT_ACCOUNT,
  LINK_SALES,
  LINK_STATEMENT,
  LABEL_OFFERS,
  NO_OFFERS_BODY,
  NO_OFFERS_TITLE,
  PUBLISHER_HEADING,
  PUBLISHER_LEDE,
  SUSPENDED_NOTICE,
  offersLiveText,
} from '../../lib/publisher-copy';
import { SINCE_FIRST, SINCE_HEADING, SINCE_NONE, sinceFromText } from '../../lib/publisher-e1-copy';
import {
  ACCOUNT_HEADING,
  CARDS_LABEL,
  CARD_OFFERS_BODY,
  CARD_PAYOUT_BODY,
  CARD_SALES_BODY,
  CARD_STATEMENT_BODY,
  FACT_PAYEE,
  FACT_SETTLEMENT,
  FACT_TERMS,
  NO_SALES_NOTE,
  OTHER_CURRENCIES_NOTE,
  TILES_LABEL,
  TILE_NET,
  TILE_NET_NOTE,
  TILE_REFUNDS,
  TILE_UNITS,
  TILE_UNITS_NOTE,
  payeeChip,
  payeeDetail,
  primaryBlock,
  reversalsNote,
  sinceItems,
  statusChip,
  termsChip,
  termsDetail,
} from '../../lib/publisher-home-copy';
import { formatDateTime, formatMinor } from '../../lib/format';
import { LINK_PUBLISHER_TERMS } from '../../lib/agreement-copy';

export const metadata: Metadata = { title: 'Publisher' };

// PUB-A1: the read only home of the signed-in publisher. The id comes from the session and nowhere
// else: the page reads no parameters, and the engine filters every query by it.
// PUB-UI-HOME: the same stored facts as figure tiles, an account panel, four cards and a feed. The figures
// come from the statement read model the sales page uses (engine.publisherStatement); nothing is computed here.
export default async function PublisherHome() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher');
  const a = await app();
  const home = await a.engine.publisherHome(actor);
  if (home === null) redirect('/signin?next=/publisher');
  // PUB-E1: what changed since the last visit. Reading it records this visit in the publisher's own row.
  const since = await a.engine.publisherSince(actor);
  const feed = since?.counts == null ? [] : sinceItems(since.counts);
  const agreement = await a.engine.publisherAgreement(actor);
  const statement = await a.engine.publisherStatement(actor);
  const { block, others } = primaryBlock(
    statement === null ? [] : salesTotals(statement.blocks),
    a.environment,
  );
  const status = statusChip(home.status);
  const payee = payeeChip(home.payee);
  const terms = termsChip(agreement);
  return (
    <>
      <header className="pk-head">
        <div>
          <p className="pk-eyebrow">{PUBLISHER_HEADING}</p>
          <h1 data-testid="publisher-name">{home.display_name}</h1>
          <p className="lede">{PUBLISHER_LEDE}</p>
        </div>
        <div className="pk-head-aside">
          <EnvLabel environment={block?.environment ?? a.environment} />
          <Chip tone={status.tone} testId="publisher-status">
            {status.label}
          </Chip>
        </div>
      </header>
      {home.status === 'suspended' ? (
        <div className="pk-notice pk-notice-bad">
          <p role="status" data-testid="publisher-notice">
            <strong>{SUSPENDED_NOTICE}</strong>
          </p>
        </div>
      ) : null}
      {home.status === 'applied' ? (
        <div className="pk-notice">
          <p role="status" data-testid="publisher-notice">
            <strong>{APPLIED_NOTICE}</strong>
          </p>
        </div>
      ) : null}
      <ul className="pk-tiles" aria-label={TILES_LABEL} data-testid="publisher-tiles">
        <li>
          <StatTile
            label={LABEL_OFFERS}
            value={String(home.offers_live)}
            note={<span data-testid="publisher-offers">{offersLiveText(home.offers_live)}</span>}
          />
        </li>
        <li>
          <StatTile
            label={TILE_UNITS}
            value={String(block?.units_paid ?? 0)}
            note={block === null ? NO_SALES_NOTE : TILE_UNITS_NOTE}
            testId="publisher-tile-units"
          />
        </li>
        {block === null ? null : (
          <>
            <li>
              <StatTile
                label={TILE_REFUNDS}
                value={formatMinor(block.refunds_minor, block.currency)}
                note={
                  block.reversals_minor > 0
                    ? reversalsNote(formatMinor(block.reversals_minor, block.currency))
                    : undefined
                }
                testId="publisher-tile-refunds"
              />
            </li>
            <li>
              <StatTile
                label={TILE_NET}
                value={formatMinor(block.net_minor, block.currency)}
                note={TILE_NET_NOTE}
                testId="publisher-tile-net"
              />
            </li>
          </>
        )}
      </ul>
      {others > 0 ? (
        <p className="muted" data-testid="publisher-tiles-other">
          {OTHER_CURRENCIES_NOTE}
        </p>
      ) : null}
      <Section title={ACCOUNT_HEADING} id="account">
        <div className="pk-panel">
          <dl className="pk-facts">
            <dt>{FACT_PAYEE}</dt>
            <dd data-testid="publisher-payee">
              <span className="pk-fact-line">
                <Chip tone={payee.tone}>{payee.label}</Chip>
                <span>{payeeDetail(home.payee)}</span>
              </span>
            </dd>
            <dt>{FACT_SETTLEMENT}</dt>
            <dd data-testid="publisher-settlement">{home.settlement.sentence}</dd>
            <dt>{FACT_TERMS}</dt>
            <dd data-testid="publisher-agreement">
              <span className="pk-fact-line">
                <Chip tone={terms.tone}>{terms.label}</Chip>
                {agreement === null ? null : <span>{termsDetail(agreement)}</span>}
                <Link href="/legal/publisher-terms">{LINK_PUBLISHER_TERMS}</Link>
              </span>
            </dd>
          </dl>
        </div>
      </Section>
      <Section title={CARDS_LABEL} id="next">
        <ul className="pk-cards pk-cards-home" data-testid="publisher-links">
          <li>
            <HomeCard
              slug="offers"
              href="/publisher/offers"
              title={LINK_OFFERS}
              body={CARD_OFFERS_BODY}
            />
          </li>
          <li>
            <HomeCard
              slug="sales"
              href="/publisher/sales"
              title={LINK_SALES}
              body={CARD_SALES_BODY}
            />
          </li>
          <li>
            <HomeCard
              slug="statement"
              href="/publisher/statement"
              title={LINK_STATEMENT}
              body={CARD_STATEMENT_BODY}
            />
          </li>
          <li>
            <HomeCard
              slug="payout"
              href="/publisher/payout-account"
              title={LINK_PAYOUT_ACCOUNT}
              body={CARD_PAYOUT_BODY}
            />
          </li>
        </ul>
      </Section>
      <section className="pk-section" aria-labelledby="since-heading" data-testid="publisher-since">
        <h2 id="since-heading">{SINCE_HEADING}</h2>
        {since === null || since.first_visit ? (
          <p className="pk-feed-note">{SINCE_FIRST}</p>
        ) : feed.length === 0 ? (
          <p className="pk-feed-note">{SINCE_NONE}</p>
        ) : (
          <ul className="pk-feed">
            {feed.map((item) => (
              <li key={item.kind}>
                <Chip tone={item.chip.tone}>{item.chip.label}</Chip>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        )}
        {since?.since == null ? null : (
          <p className="muted pk-since-from">{sinceFromText(formatDateTime(since.since))}</p>
        )}
      </section>
      {home.offers_live === 0 ? (
        <div className="pk-section">
          <EmptyState title={NO_OFFERS_TITLE}>{NO_OFFERS_BODY}</EmptyState>
        </div>
      ) : null}
    </>
  );
}
