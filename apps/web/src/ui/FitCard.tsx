'use client';
import type { AccessOption, FitCard as FitCardData, FitDimension, Money } from '@umsbx/contracts';
import { formatMinor, optionLabel } from '../lib/format';
import { CoverTile } from './CoverTile';
import { WHY_THIS_FIT, accessDaysLine, priceLine, splitFitRows } from '../lib/buyer-copy';

const LEVEL_WORD = ['no match', 'weak', 'good', 'strong'] as const;
const BAND_TEXT = { strong: 'Strong fit', good: 'Good fit', partial: 'Partial fit' } as const;

const ICON: Record<FitDimension['key'], string> = {
  topic: 'M4 5h16M4 10h10M4 15h16M4 20h8',
  budget: 'M12 3v18M7 8c0-2 2-3 5-3s5 1 5 3-2 3-5 3-5 1-5 3 2 3 5 3 5-1 5-3',
  access: 'M5 11V8a7 7 0 0 1 14 0v3M5 11h14v10H5z',
  language: 'M4 5h10M9 3v2M6 9c1 4 4 7 8 8M13 9c-1 4-4 7-8 8M14 21l4-10 4 10M15.5 18h5',
  recency: 'M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4',
};

function Dots({ level }: { level: FitDimension['level'] }) {
  return (
    <span className="dots" aria-hidden="true">
      {[1, 2, 3].map((n) => (
        <span key={n} className={level !== null && n <= level ? 'dot dot-on' : 'dot'} />
      ))}
    </span>
  );
}

function FitRow({ d }: { d: FitDimension }) {
  return (
    <li className="fit-row">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path d={ICON[d.key]} fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      <span className="fit-label">{d.label}</span>
      <Dots level={d.level} />
      <span className="fit-text">
        {d.level === null ? 'not assessed' : LEVEL_WORD[d.level]}
        {d.evidence ? <span className="muted">: {d.evidence}</span> : null}
      </span>
    </li>
  );
}

// A card is advice, not a score: levels are words and dots with the evidence beside them, and a
// dimension that could not be assessed is an empty outline that says so (never a number).
export function FitCard({
  card,
  title,
  publisher,
  price,
  option,
  onChoose,
}: {
  card: FitCardData;
  title: string;
  publisher: string;
  price: Money;
  option: AccessOption;
  onChoose: () => void;
}) {
  const priceText = formatMinor(price.minor, price.currency);
  const { assessed, notAssessed } = splitFitRows(card.dimensions);
  return (
    <article className="fit-card" data-testid="fit-card" aria-label={`${title}, ${publisher}`}>
      <CoverTile publisher={publisher} title={title} tag={optionLabel(option)} />
      <div className="fit-body">
        <header>
          <h3>{title}</h3>
          <p className="muted">{publisher}</p>
          {card.band ? (
            <span className={`chip chip-${card.band}`}>{BAND_TEXT[card.band]}</span>
          ) : null}
          <p className="price-line">
            <strong className="price">{priceText}</strong>
            <span className="muted">{priceLine(priceText, option).slice(priceText.length)}</span>
          </p>
          <p className="muted access-days">{accessDaysLine(option)}</p>
        </header>
        {assessed.length > 0 ? (
          <ul className="fit-rows">
            {assessed.map((d) => (
              <FitRow key={d.key} d={d} />
            ))}
          </ul>
        ) : null}
        {notAssessed.length > 0 ? (
          <details className="fit-more">
            <summary>{WHY_THIS_FIT}</summary>
            <ul className="fit-rows">
              {notAssessed.map((d) => (
                <FitRow key={d.key} d={d} />
              ))}
            </ul>
          </details>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={onChoose}>
          Choose this article
        </button>
      </div>
    </article>
  );
}
