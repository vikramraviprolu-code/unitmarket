import { coverHue } from '../../../lib/cover';
import { offerInitials } from '../../../lib/offers-view';

// The cover of an offer card: the buyer poster look (the .cover hues in globals.css) with the offer's initials.
// The hue is a fixed function of the title, so a card never changes colour. Decorative, so hidden from
// assistive tech: the title and status are in the card text.
export function OfferCover({ title }: { title: string }) {
  const hue = coverHue(title);
  return (
    <div className="cover-wrap pk-offer-cover" aria-hidden="true">
      <div className={`cover cover-h${String(hue)}`}>
        <span className="cover-ini">{offerInitials(title)}</span>
      </div>
    </div>
  );
}
