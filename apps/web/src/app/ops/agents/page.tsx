import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../server/session';
import { readOpsAgents } from '../../../composition/ops-agents';
import { EnvLabel } from '../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../ui/publisher/kit';
import { SectionNav } from '../../../ui/SectionNav';
import { CapTable, RevokeForm } from '../../../ui/ops/CapTable';
import { formatMinor } from '../../../lib/format';
import { OPS_AGENTS_SECTIONS } from '../../../lib/ops-agents-view';
import { TableScroll } from '../../publisher/pk-sales-parts';
import '../../tables.css';
import '../../publisher/pk-sales.css';
import '../pk-opshome.css';
import '../../../ui/ops/ops-a.css';

export const metadata: Metadata = { title: 'Agents and API' };

// INT-OPS-C / OPS-C.3: caps with spent and remaining, reservations, agent purchases, keys and webhook subscriptions
// with their last delivery. Without the authenticator code: no buyer id, key ids as their last four, and no revoke
// form. A webhook shows its host only; there is no pause, because a cap has no paused state.
export default async function OpsAgents() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/agents');
  const read = await readOpsAgents(actor);
  if (read === null) redirect('/signin?next=/ops/agents');
  return (
    <>
      <PageHeader
        title="Agents and API"
        aside={<EnvLabel environment={read.environment} />}
        lede={
          read.mfa
            ? 'Spending caps, the keys that use them and the webhooks owners set up. Revoking needs a reason.'
            : 'Spending caps, keys and webhooks. Buyer ids and whole key ids, and revoking, need your authenticator code.'
        }
      />
      <SectionNav label="Sections of this page" items={OPS_AGENTS_SECTIONS} />

      <Section title="Caps" id="agents-caps">
        <CapTable caps={read.caps} revokeKeys={read.revokeKeys} />
      </Section>

      <Section title="Reservations" id="agents-reservations">
        {read.reservations.length === 0 ? (
          <p className="oh-empty">No reservations.</p>
        ) : (
          <TableScroll label="Reservations">
            <table className="pk-table" aria-label="Reservations">
              <thead>
                <tr>
                  <th scope="col">Cap</th>
                  <th scope="col">Amount</th>
                  <th scope="col">State</th>
                  <th scope="col">Made</th>
                </tr>
              </thead>
              <tbody>
                {read.reservations.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" data-label="Cap">
                      {r.mandate_id}
                    </td>
                    <td className="pk-num" data-label="Amount">
                      {formatMinor(r.amount_minor, r.currency)}
                    </td>
                    <td data-label="State">{r.state}</td>
                    <td data-label="Made">{r.created_at.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section title="Agent purchases" id="agents-purchases">
        {read.purchases.length === 0 ? (
          <p className="oh-empty">No agent purchases.</p>
        ) : (
          <TableScroll label="Agent purchases">
            <table className="pk-table" aria-label="Agent purchases">
              <thead>
                <tr>
                  <th scope="col">Agent key</th>
                  <th scope="col">State</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {read.purchases.map((p, i) => (
                  <tr key={`${p.agent_key}-${p.created_at}-${String(i)}`}>
                    <td className="mono" data-label="Agent key">
                      {p.agent_key}
                    </td>
                    <td data-label="State">{p.state}</td>
                    <td data-label="When">{p.created_at.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section title="Keys" id="agents-keys">
        {read.keys.length === 0 ? (
          <p className="oh-empty">No keys.</p>
        ) : (
          <TableScroll label="API and agent keys">
            <table className="pk-table" aria-label="API and agent keys">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {read.keys.map((k) => (
                  <tr key={k.id}>
                    <td className="mono" data-label="Key">
                      {k.id}
                    </td>
                    <td data-label="Kind">{k.key_kind}</td>
                    <td data-label="Owner">
                      {k.owner === null ? `A ${k.owner_kind}` : `${k.owner_kind} ${k.owner}`}
                    </td>
                    <td data-label="Scopes">{k.scopes.join(', ')}</td>
                    <td data-label="Last used">
                      {k.last_used_at === null ? 'Never' : k.last_used_at.slice(0, 10)}
                    </td>
                    <td data-label="Action">
                      {k.revoked_at !== null ? (
                        'Revoked'
                      ) : read.revokeKeys[k.id] === undefined ? (
                        'Needs your authenticator code'
                      ) : (
                        <RevokeForm
                          kind="key"
                          id={k.id}
                          idemKey={read.revokeKeys[k.id]!}
                          label={`Revoke key ${k.id}`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section title="Webhooks" id="agents-webhooks">
        {read.webhooks.length === 0 ? (
          <p className="oh-empty">No webhook subscriptions.</p>
        ) : (
          <TableScroll label="Webhook subscriptions">
            <table className="pk-table" aria-label="Webhook subscriptions">
              <thead>
                <tr>
                  <th scope="col">Subscription</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Host</th>
                  <th scope="col">Events</th>
                  <th scope="col">Last delivery</th>
                  <th scope="col">On</th>
                </tr>
              </thead>
              <tbody>
                {read.webhooks.map((h) => (
                  <tr key={h.id}>
                    <td className="mono" data-label="Subscription">
                      {h.id}
                    </td>
                    <td data-label="Owner">{h.owner_kind}</td>
                    <td className="mono" data-label="Host">
                      {h.host ?? 'Not readable'}
                    </td>
                    <td data-label="Events">{h.event_types.join(', ')}</td>
                    <td data-label="Last delivery">
                      {h.last_status === null
                        ? 'None yet'
                        : `${h.last_status}${h.last_error === null ? '' : `, ${h.last_error}`}`}
                    </td>
                    <td data-label="On">{h.disabled_at === null ? 'Yes' : 'Disabled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
    </>
  );
}
