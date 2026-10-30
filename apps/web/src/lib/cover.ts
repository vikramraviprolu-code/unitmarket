// Cover tile hue (style spec, "Cover tile hues"): a fixed function of the publisher slug, so a tile never
// changes colour and nothing is random (lint S6). The six hues and their patterns are CSS (.cover-h0 to .cover-h5).
export function coverHue(slug: string): 0 | 1 | 2 | 3 | 4 | 5 {
  let sum = 0;
  for (let i = 0; i < slug.length; i += 1) sum += slug.charCodeAt(i);
  return (sum % 6) as 0 | 1 | 2 | 3 | 4 | 5;
}

// SKIN-B1: a poster cover belongs to one article, so the seed joins the publisher name and the title (both
// are stored data on every screen that shows a card). Two articles of one publisher can differ in hue.
export function coverSeed(publisher: string, title: string): string {
  return `${publisher}/${title}`;
}

// Up to two letters for the big initials: the first letters of the first two words, or the first two
// letters of a single word. No letters at all gives an empty string and the tile shows no initials.
export function coverInitials(name: string): string {
  const words = name.match(/\p{L}+/gu) ?? [];
  const [first, second] = words;
  if (first === undefined) return '';
  if (second !== undefined)
    return (Array.from(first)[0] ?? '').toUpperCase() + (Array.from(second)[0] ?? '').toUpperCase();
  return Array.from(first).slice(0, 2).join('').toUpperCase();
}
