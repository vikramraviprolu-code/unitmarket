import type { LegalDoc } from '../lib/legal-copy';
import { LEGAL_BANNER, LEGAL_SANDBOX_LINE } from '../lib/legal-copy';
import { SectionNav } from './SectionNav';
import { legalSectionIds } from './section-id';

// One static legal page: the draft banner and the sandbox line first, then the title, the fixed
// date and each section. A server component with no client code; the words live in lib/legal-copy.ts.
export function LegalPage({ doc }: { doc: LegalDoc }) {
  // One tab per heading (WEB-THEME), so a long page can be jumped through; the ids come from the headings.
  const ids = legalSectionIds(doc.sections.map((s) => s.heading));
  return (
    <article data-testid={`legal-${doc.slug}`}>
      <div className="banner banner-warn" role="note" data-testid="legal-banner">
        <strong className="banner-title">{LEGAL_BANNER}</strong>
        <div>{LEGAL_SANDBOX_LINE}</div>
      </div>
      <h1>{doc.title}</h1>
      <p className="muted">{doc.updated}</p>
      <SectionNav
        label="On this page"
        items={doc.sections.map((section, i) => ({ id: ids[i] ?? '', label: section.heading }))}
      />
      {doc.sections.map((section, i) => (
        <section key={section.heading} id={ids[i]} aria-labelledby={`${ids[i] ?? ''}-h`}>
          <h2 id={`${ids[i] ?? ''}-h`}>{section.heading}</h2>
          {section.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
    </article>
  );
}
