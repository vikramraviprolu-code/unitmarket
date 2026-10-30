// Cover tile hue (style spec, "Cover tile hues"): a fixed function of the publisher slug, so a tile never
// changes colour and nothing is random (lint S6). The six hues and their patterns are CSS (.cover-h0 to .cover-h5).
export function coverHue(slug: string): 0 | 1 | 2 | 3 | 4 | 5 {
  let sum = 0;
  for (let i = 0; i < slug.length; i += 1) sum += slug.charCodeAt(i);
  return (sum % 6) as 0 | 1 | 2 | 3 | 4 | 5;
}
