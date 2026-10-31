import './section-nav.css';

export interface SectionNavItem {
  /** The id of the section on the same page, without the hash. */
  id: string;
  label: string;
}

/**
 * A sticky row of links that jump to sections of one long page (owner feedback 31 Oct: long scrolls).
 * Plain anchors, no script and no hidden content, so it works with the keyboard, with a screen reader
 * and with scripts off. The section element needs the matching `id`. Colours come from the skin tokens only.
 */
export function SectionNav({ label, items }: { label: string; items: SectionNavItem[] }) {
  return (
    <nav className="section-nav" aria-label={label} data-testid="section-nav">
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`}>{i.label}</a>
          </li>
        ))}
        <li className="section-nav-top">
          <a href="#main">Back to top</a>
        </li>
      </ul>
    </nav>
  );
}
