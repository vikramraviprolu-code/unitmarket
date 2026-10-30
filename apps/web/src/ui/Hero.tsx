import type { ReactNode } from 'react';
import { HarbourScene } from './HarbourScene';

// The poster hero of the home and find pages: a rounded panel in the skin's header colours, a big rounded
// heading, one line of copy and the pill search. Colours come from tokens, so each skin dresses it itself.
// Deep Harbour also draws its harbour scene behind the headline (SKIN-B); Bright Market hides it by CSS.
export function Hero({ children }: { children: ReactNode }) {
  return (
    <section className="hero">
      <HarbourScene />
      <div className="hero-in">{children}</div>
    </section>
  );
}
