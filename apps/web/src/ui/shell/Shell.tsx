import type { ReactNode } from 'react';
import type { EnvironmentLabel } from '@umsbx/contracts';
import { EnvLabel } from '../EnvLabel';
import type { ShellPersona } from '../../lib/shell-tabs';
import { Breadcrumb } from './Breadcrumb';
import { PhoneBar } from './PhoneBar';
import { SearchSlot } from './SearchSlot';
import { Tabs } from './Tabs';
import './shell.css';

// INT-UI0 / UI0.1: the one shell of the operator, the buyer and the seller. Tabs, a breadcrumb, the
// environment pill read from stored data, a search slot and, on a phone, a bottom tab bar. It takes a persona
// and the environment and nothing about the person: a seller's shell never holds a buyer's identity. The
// layout passes the page (the <main> element) as children so the phone bar can follow it.
export function Shell({
  persona,
  environment,
  children,
}: {
  persona: ShellPersona;
  environment: EnvironmentLabel;
  children: ReactNode;
}) {
  return (
    <>
      <div className="shell" data-persona={persona}>
        <div className="shell-inner">
          <div className="shell-row">
            <Tabs persona={persona} />
            <SearchSlot persona={persona} />
          </div>
          <div className="shell-crumbrow">
            <Breadcrumb />
            <EnvLabel environment={environment} className="shell-env" />
          </div>
        </div>
      </div>
      {children}
      <PhoneBar persona={persona} />
    </>
  );
}
