import type { LegalDoc } from '../lib/legal-copy';
import { LEGAL_BANNER, LEGAL_SANDBOX_LINE } from '../lib/legal-copy';

// One static legal page: the draft banner and the sandbox line first, then the title, the fixed
// date and each section. A server component with no client code; the words live in lib/legal-copy.ts.
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <article data-testid={`legal-${doc.slug}`}>
      <div className="banner banner-warn" role="note" data-testid="legal-banner">
        <strong className="banner-title">{LEGAL_BANNER}</strong>
        <div>{LEGAL_SANDBOX_LINE}</div>
      </div>
      <h1>{doc.title}</h1>
      <p className="muted">{doc.updated}</p>
      {doc.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
    </article>
  );
}
