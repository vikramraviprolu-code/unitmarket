import Link from 'next/link';
import { CoverTile } from './CoverTile';

// A poster card for the home shelf: cover, title, publisher and the lowest price. Text comes from the
// stored offer; the tag is the cheapest access option's label.
export function OfferTile({
  href,
  title,
  publisher,
  priceText,
  bindingText = null,
  tag,
}: {
  href: string;
  title: string;
  publisher: string;
  priceText: string;
  /** The binding seller amount beside a converted price; null when nothing was converted. */
  bindingText?: string | null;
  tag: string;
}) {
  return (
    <li className="tile">
      <CoverTile publisher={publisher} title={title} tag={tag} />
      <div className="tile-body">
        <h3>
          <Link href={href}>{title}</Link>
        </h3>
        <p className="muted">{publisher}</p>
        <p className="price-line">
          <span className="muted">from </span>
          <strong className="price">{priceText}</strong>
        </p>
        {bindingText !== null ? <p className="muted binding-line">{bindingText}</p> : null}
      </div>
    </li>
  );
}
