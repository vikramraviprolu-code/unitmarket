import Link from 'next/link';
import { useId } from 'react';
import type { ReactNode } from 'react';

// Shared pieces for the publisher and operator-publisher screens (PUB-UI). Colours come only from the skin
// tokens in globals.css and skin-harbour.css, so both looks work. Styles live in app/publisher/publisher.css.

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/** A small status pill. Colour always comes with its words, never alone. */
export function Chip({
  tone = 'neutral',
  children,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span className={`pk-chip pk-chip-${tone}`} data-testid={testId}>
      {children}
    </span>
  );
}

/** One figure with its label. The value is read from stored records by the page, never computed here. */
export function StatTile({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="pk-tile" data-testid={testId}>
      <p className="pk-tile-label">{label}</p>
      <p className="pk-tile-value">{value}</p>
      {note ? <p className="pk-tile-note">{note}</p> : null}
    </div>
  );
}

/** A whole-card link with a title and one line. */
export function ActionCard({
  href,
  title,
  children,
  testId,
}: {
  href: string;
  title: string;
  children?: ReactNode;
  testId?: string;
}) {
  // The link is named by its title only and described by the line under it, so a screen reader and a test
  // that looks a link up by its exact name both find 'Your offers', not 'Your offers See what is on sale'.
  const id = useId();
  return (
    <Link
      className="pk-card"
      href={href}
      data-testid={testId}
      aria-labelledby={`${id}-t`}
      aria-describedby={children ? `${id}-d` : undefined}
    >
      <span className="pk-card-title" id={`${id}-t`}>
        {title}
      </span>
      {children ? (
        <span className="pk-card-body" id={`${id}-d`}>
          {children}
        </span>
      ) : null}
    </Link>
  );
}

/** Page heading with an optional right-hand part (an environment label, a button). */
export function PageHeader({
  title,
  lede,
  aside,
}: {
  title: string;
  lede?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="pk-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {aside ? <div className="pk-head-aside">{aside}</div> : null}
    </header>
  );
}

/** A titled block on a surface. Use for each section of a page. */
export function Section({
  title,
  children,
  id,
}: {
  title?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="pk-section" aria-labelledby={id && title ? `${id}-h` : undefined} id={id}>
      {title ? <h2 id={id ? `${id}-h` : undefined}>{title}</h2> : null}
      {children}
    </section>
  );
}
