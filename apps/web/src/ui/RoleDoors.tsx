import Link from 'next/link';
import {
  DOORS_LEDE,
  DOORS_TITLE,
  JUDGES_LEAD,
  JUDGES_LINK,
  SIGNED_IN_HERE,
  doors,
} from '../lib/account-copy';
import type { Door } from '../lib/account-copy';
import '../app/auth.css';

// The three doors of the landing page (ID-ACCOUNTS). Server rendered: three real links, no script. A signed in
// actor sees their own door as a way home ("Go to your library", ...) and the other two stay as they were.
type Kind = 'buyer' | 'publisher' | 'operator' | null;
const OWN: Record<Door['id'], Exclude<Kind, null>> = {
  buyer: 'buyer',
  seller: 'publisher',
  operator: 'operator',
};

// Decorative pictures, drawn with the text colour of the band. The words next to them carry the meaning.
function Glyph({ id }: { id: Door['id'] }) {
  const common = {
    className: 'role-door-glyph',
    viewBox: '0 0 48 48',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  if (id === 'buyer')
    return (
      <svg {...common}>
        <path d="M8 11h12a4 4 0 0 1 4 4v22a3 3 0 0 0-3-3H8z" />
        <path d="M40 11H28a4 4 0 0 0-4 4v22a3 3 0 0 1 3-3h13z" />
      </svg>
    );
  if (id === 'seller')
    return (
      <svg {...common}>
        <path d="M10 38l4-11L33 8l7 7-19 19z" />
        <path d="M28 13l7 7" />
        <path d="M10 38h14" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M24 6l15 6v11c0 9-6 16-15 19C15 39 9 32 9 23V12z" />
      <path d="M17 24l5 5 9-10" />
    </svg>
  );
}

export function RoleDoors({ actorKind, days }: { actorKind: Kind; days?: number }) {
  return (
    <section className="role-doors" aria-labelledby="doors-title" data-testid="role-doors">
      <div className="role-doors-head">
        <h2 id="doors-title">{DOORS_TITLE}</h2>
        <p>{DOORS_LEDE}</p>
      </div>
      <ul className="role-door-list">
        {doors(days).map((d) => {
          const here = actorKind === OWN[d.id];
          return (
            <li key={d.id} className={`role-door role-door-${d.id}`} data-testid={`door-${d.id}`}>
              <div className="role-door-band">
                <Glyph id={d.id} />
                <div>
                  <h3>{d.label}</h3>
                  <p className="role-door-tag">{d.tag}</p>
                </div>
              </div>
              <div className="role-door-body">
                {here ? <p className="role-door-here">{SIGNED_IN_HERE}</p> : null}
                <p>{d.line}</p>
                <p className="role-door-need">{d.need}</p>
                <div className="role-door-go">
                  <Link className="btn btn-primary auth-big" href={here ? d.home_href : d.href}>
                    {here ? d.home_button : d.button}
                  </Link>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="role-doors-judges">
        {JUDGES_LEAD} <Link href="/signin">{JUDGES_LINK}</Link>.
      </p>
    </section>
  );
}
