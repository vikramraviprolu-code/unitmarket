import Link from 'next/link';
import { readBuyerHome } from '../../composition/buyer';
import { app } from '../../server/access';
import { homeModel } from '../../lib/buyer-home-view';
import { SpendMeter } from '../../ui/buyer/SpendMeter';
import { EnvLabel } from '../../ui/EnvLabel';
import { PageHeader } from '../../ui/publisher/kit';
import '../../ui/buyer/buyer.css';

// INT-BUY / BUY.5: the buyer Home, a server component. The four sections come in a fixed order from
// lib/buyer-home-view.ts; this paints them. It reads through the buyer composition module only.
export async function BuyerHome({ buyer_id }: { buyer_id: string }) {
  const a = await app();
  const read = await readBuyerHome(buyer_id);
  const model = homeModel({ ...read, now: a.security.clock.now() });
  return (
    <div data-testid="buyer-home">
      <PageHeader
        title="Your home"
        aside={<EnvLabel environment={a.environment} />}
        lede="What needs you, what to read next, what your agents may spend and what you bought lately."
      />
      {model.sections.map((s) => (
        <section
          key={s.id}
          className="home-section"
          aria-labelledby={`home-${s.id}`}
          data-testid={`home-${s.id}`}
        >
          <h2 id={`home-${s.id}`}>{s.heading}</h2>
          {s.empty !== null ? <p className="muted">{s.empty}</p> : null}
          {s.items.length > 0 ? (
            <ul className="home-list">
              {s.items.map((i) => (
                <li key={i.key}>
                  <Link href={i.href}>{i.text}</Link>
                  {i.note !== null ? <span className="muted"> {i.note}</span> : null}
                  {i.meter !== undefined ? <SpendMeter card={i.meter} label={i.text} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {s.more !== null ? (
            <p>
              <Link href={s.more.href}>{s.more.label}</Link>
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
