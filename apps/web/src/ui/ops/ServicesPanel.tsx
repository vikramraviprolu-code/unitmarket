'use client';
import { useMemo, useState } from 'react';
import { parseCloudStatus, servicesView } from '../../lib/services-view';
import type { AppStatus } from '../../lib/services-view';
import { Chip } from '../publisher/kit';

// INT-CTL / CTL.2: the services panel. The operator pastes the output of `corepack pnpm cloud:status --json` into
// the box; it is checked here against the schema and shown as five cards. Nothing is sent anywhere, nothing is
// stored, and no button acts on the cloud: the cards show the commands to run in a terminal.
export function ServicesPanel({ app }: { app: AppStatus | null }) {
  const [text, setText] = useState('');
  const [cloud, setCloud] = useState<Parameters<typeof servicesView>[0]['cloud']>(null);
  const [refusal, setRefusal] = useState('');
  const view = useMemo(() => servicesView({ app, cloud }), [app, cloud]);
  function read(next: string) {
    setText(next);
    if (next.trim() === '') {
      setCloud(null);
      setRefusal('');
      return;
    }
    const r = parseCloudStatus(next);
    if (r.ok) {
      setCloud(r.value);
      setRefusal('');
    } else {
      setCloud(null);
      setRefusal(r.message);
    }
  }
  return (
    <div data-testid="services-panel">
      <p>
        <label htmlFor="cloud-status-paste">Paste the output of the cloud status command</label>
      </p>
      <textarea
        id="cloud-status-paste"
        rows={6}
        value={text}
        onChange={(e) => read(e.target.value)}
        spellCheck={false}
      />
      <p role="status" data-testid="services-refusal">
        {refusal}
      </p>
      {view.checked_at !== null ? (
        <p>Checked at {view.checked_at}.</p>
      ) : (
        <p>No cloud status pasted yet.</p>
      )}
      <ul className="oh-grid" aria-label="Services">
        {view.cards.map((c) => (
          <li key={c.key}>
            <div className="pk-panel" data-testid={`service-${c.key}`}>
              <p className="oh-switch-name">{c.title}</p>
              <Chip tone={c.state === 'unknown' ? 'neutral' : 'info'}>{c.state}</Chip>
              <ul className="oh-list">
                {c.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="oh-hint">Run in a terminal:</p>
              <ul className="oh-list">
                {c.commands.map((cmd) => (
                  <li key={cmd}>
                    <code>{cmd}</code>
                  </li>
                ))}
              </ul>
              {c.cloud_shell_url !== null ? (
                <p>
                  <a href={c.cloud_shell_url} rel="noopener noreferrer" target="_blank">
                    Open Cloud Shell
                  </a>{' '}
                  {c.audit_url !== null ? (
                    <a href={c.audit_url} rel="noopener noreferrer" target="_blank">
                      Audit log
                    </a>
                  ) : null}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
