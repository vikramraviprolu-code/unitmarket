import { coverHue, coverInitials, coverSeed } from '../lib/cover';

// A poster cover for an article card (Bright Market, option D). Hue and pattern are a fixed function of the
// article's own data (publisher name and title), so a cover never changes and nothing is random. The tile is
// decorative: it says nothing the card does not already say in text, so it is hidden from assistive tech.
// The optional tag is the one place the yellow accent is used.
export function CoverTile({
  publisher,
  title,
  tag,
}: {
  publisher: string;
  title: string;
  tag?: string;
}) {
  const hue = coverHue(coverSeed(publisher, title));
  return (
    <div className="cover-wrap" aria-hidden="true">
      <div className={`cover cover-h${hue}`}>
        <span className="cover-ini">{coverInitials(publisher)}</span>
        <span className="cover-pub">{publisher}</span>
      </div>
      {tag ? <span className="tag">{tag}</span> : null}
    </div>
  );
}
