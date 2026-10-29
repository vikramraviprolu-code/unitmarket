import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor } from '../../../../server/session';
import { StatusBanner } from '../../../../ui/StatusBanner';

export const metadata: Metadata = { title: 'Dry-run checkout' };

export default async function DryRunCheckout({ params }: { params: Promise<{ order: string }> }) {
  const { order } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer')
    redirect(`/signin?next=${encodeURIComponent(`/checkout/dry-run/${order}`)}`);
  const a = await app();
  if (a.environment !== 'dryrun') notFound();
  const view = await a.engine.orderView({ order_ref: order, actor });
  if (view === null) notFound();
  const steps = (await a.engine.checkoutSteps({ order_ref: order, actor })) ?? [];
  const scenarios = a.engine.dryRunScenarios();
  return (
    <>
      <h1>Dry run: no PayPal</h1>
      <StatusBanner tone="warn" title="Dry run: no PayPal">
        This page stands in for the PayPal approval page. No PayPal page is opened, no account is
        used and no money moves.
      </StatusBanner>
      {steps.length > 1 ? (
        <>
          <p>
            This order has {steps.length} payments, one for each publisher. Each one is approved on
            its own and has its own pretend outcome.
          </p>
          {steps.map((s) => (
            <form
              key={s.position}
              action="/checkout/return"
              method="get"
              data-testid={`dryrun-step-${String(s.position)}`}
            >
              <input type="hidden" name="ref" value={view.order_ref} />
              <input type="hidden" name="po" value={String(s.position)} />
              <h2>
                Payment {s.position} of {steps.length}: {s.publisher}
              </h2>
              {s.state === 'awaiting_buyer' ? (
                <>
                  <div className="field">
                    <label htmlFor={`scenario-${String(s.position)}`}>
                      Payment {s.position} of {steps.length}: what should the pretend payment do?
                    </label>
                    <select
                      id={`scenario-${String(s.position)}`}
                      name="scenario"
                      defaultValue="happy"
                    >
                      {scenarios.map((sc) => (
                        <option key={sc.id} value={sc.id}>
                          {sc.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="actions">
                    <button className="btn btn-primary" type="submit">
                      Approve payment {s.position} of {steps.length} (dry run)
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted">This payment is already approved in this dry run.</p>
              )}
            </form>
          ))}
          <p>
            <Link className="btn" href={`/orders/${encodeURIComponent(view.order_ref)}`}>
              Cancel
            </Link>
          </p>
        </>
      ) : (
        <form action="/checkout/return" method="get">
          <input type="hidden" name="ref" value={view.order_ref} />
          <div className="field">
            <label htmlFor="scenario">What should the pretend payment do?</label>
            <select id="scenario" name="scenario" defaultValue="happy">
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit">
              Approve payment (dry run)
            </button>
            <Link className="btn" href={`/orders/${encodeURIComponent(view.order_ref)}`}>
              Cancel
            </Link>
          </div>
        </form>
      )}
    </>
  );
}
