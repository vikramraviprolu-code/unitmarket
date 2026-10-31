// WEB-THEME: ids for the sections of a page, made from their headings, so the section tabs and the sections
// always agree. Pure, so a unit test pins it.

/** A heading as an id: lower case words joined by one hyphen. Never empty and never starts with a digit. */
export function sectionSlug(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return 'section';
  return /^[0-9]/.test(slug) ? `s-${slug}` : slug;
}

/** One id per heading, in order. A repeated heading gets -2, -3 and so on. */
export function legalSectionIds(headings: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((h) => {
    const base = sectionSlug(h);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${String(n)}`;
  });
}
