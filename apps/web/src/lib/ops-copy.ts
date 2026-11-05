// The words of the Operations Start control and the section tabs of the operator pages (WEB-OPS-START).
// Pure: no server module, no clock. Wording rules: D-051, no italics, no dashes. Every refusal the start
// route can give has one plain sentence here; none carries a stack, a code path or a stored value.

export interface OpsSection {
  /** The id of the section on the same page, without the hash. */
  id: string;
  label: string;
}

// ---- Start PayPal ------------------------------------------------------------------------------

export const OPS_START_HEADING = 'Start PayPal calls';
export const OPS_START_BUTTON = 'Start PayPal';
export const OPS_START_REASON_LABEL = 'Why are you starting PayPal calls?';
export const OPS_START_SCOPE_LABEL = 'Type the scope name to confirm';
export const OPS_START_SCOPE_HINT = (scope: string): string =>
  `The active approval is for ${scope}.`;
export const OPS_START_LEDE =
  'This turns the PayPal switch on. It works only while an active approval row covers it, and it cannot add one: the owner does that at their own terminal.';
export const OPS_START_NEEDS_CODE = 'Sign in with your authenticator code to start PayPal.';
export const OPS_START_ALREADY_ON = 'PayPal calls are already on, so there is nothing to start.';
export const OPS_START_NO_APPROVAL =
  'There is no active approval, so PayPal cannot be started from here. The owner adds one at their own terminal.';
export const OPS_CONNECT_FLAG_OFF =
  'The connection flag is off. No PayPal call goes out until the owners turn it on in Cloud Run.';
export const OPS_START_DONE = 'PayPal calls are on (in force within 5 seconds).';
// WEB-POLISH-2: the switch is on but the Cloud Run connection flag is off (Start never touches the flag, D-070).
export const OPS_START_DONE_FLAG_OFF =
  'The switch is on, but the connection flag is off, so no PayPal call goes out.';
export const OPS_STOP_DONE =
  'PayPal calls are stopped (in force within 5 seconds). To turn them on again, use Start PayPal while signed in with your authenticator code, or the owner runs pnpm safety:resume at their terminal.';
export const OPS_START_ERROR_TITLE = 'Could not start';

export const startDoneText = (calls_left: number, flagOff = false): string =>
  `${flagOff ? OPS_START_DONE_FLAG_OFF : OPS_START_DONE} ${String(calls_left)} ${calls_left === 1 ? 'call is' : 'calls are'} left today.`;

/**
 * Which control the Kill switch block shows. Both always render: the one that does not apply is replaced
 * by one sentence saying why. The server still checks everything again; this only chooses the words.
 */
export interface KillControlsView {
  start: 'form' | 'already_on' | 'needs_code' | 'no_approval';
  /** Always the form: a stop is idempotent and needs no authenticator code, so it is never hidden. */
  stop: 'form';
}
export function killControlsView(i: {
  outboundOn: boolean;
  hasCode: boolean;
  activeScope: string | null;
}): KillControlsView {
  if (i.outboundOn) return { start: 'already_on', stop: 'form' };
  if (!i.hasCode) return { start: 'needs_code', stop: 'form' };
  if (i.activeScope === null) return { start: 'no_approval', stop: 'form' };
  return { start: 'form', stop: 'form' };
}

/** The sentence for each way the start route refuses. */
export function startRefusalText(code: string): string {
  switch (code) {
    case 'mfa_required':
      return 'Starting PayPal needs a sign-in with your authenticator code. Sign out and sign in again with the code.';
    case 'operator_required':
      return 'This account cannot start PayPal. Only an operator who signed in with the authenticator code can.';
    case 'no_active_approval':
      return 'There is no active approval for this app, or it has ended. The owner adds a new one at their own terminal.';
    case 'scope_mismatch':
      return 'The active approval is for a different scope than this app serves, so PayPal was not started.';
    case 'budget_used_up':
      return 'The calls allowed today under the active approval are used up, so PayPal was not started.';
    case 'scope_not_confirmed':
      return 'The scope name you typed does not match the active approval. Check it and try again.';
    case 'already_on':
      return 'PayPal calls are already on, so nothing was changed.';
    case 'switch_locked':
      return 'The switch could not be changed right now, so the start may not have happened. Reload the page to see the switch.';
    case 'switch_changed':
      return 'The switch was changed by someone else while you were starting it, so nothing was changed here. Reload the page to see the switch.';
    case 'start_unknown':
      return 'Something went wrong, so the start may not have happened. Reload the page to see the switch.';
    case 'reason_required':
      return 'Please say why you are starting PayPal calls.';
    default:
      return 'PayPal was not started. Nothing was changed.';
  }
}

/** The state of the switch read back after an unsure start, as one sentence. */
export const switchNowText = (on: boolean | null): string =>
  on === null
    ? 'The switch could not be read.'
    : on
      ? 'The switch reads On now.'
      : 'The switch reads Off now.';

// ---- Section tabs ------------------------------------------------------------------------------
// One list per operator page. Each id is the id of a section element on that page, in page order.

// INT-UI0: Home keeps the kill switch and the alerts, and a stub for each block that moved (lib/shell-moves.ts).
export const OPS_HOME_SECTIONS: OpsSection[] = [
  { id: 'ops-kill', label: 'Kill switch' },
  { id: 'ops-alerts', label: 'Alerts' },
  { id: 'ops-moved', label: 'Moved sections' },
];

export const OPS_MONEY_SECTIONS: OpsSection[] = [
  { id: 'ops-refunds', label: 'Refunds' },
  { id: 'ops-orders', label: 'Orders' },
  { id: 'ops-totals', label: 'Totals' },
  { id: 'ops-states', label: 'States' },
  { id: 'ops-invariants', label: 'Invariants' },
];

export const OPS_SELLERS_SECTIONS: OpsSection[] = [
  { id: 'ops-sellers-links', label: 'Seller pages' },
  { id: 'ops-shared-payee', label: 'Shared payee' },
];

export const OPS_CONTROLS_SECTIONS: OpsSection[] = [
  { id: 'ops-switches', label: 'Switches' },
  { id: 'ops-gate-section', label: 'Approval gate' },
];

export const OPS_PUBLISHERS_SECTIONS: OpsSection[] = [
  { id: 'ops-pub-summary', label: 'Summary' },
  { id: 'ops-pub-applicants', label: 'Applicants' },
  { id: 'ops-pub-list', label: 'Publishers' },
];

export const OPS_PAYEE_SECTIONS: OpsSection[] = [
  { id: 'ops-payee-summary', label: 'Summary' },
  { id: 'ops-payee-queue', label: 'Requests' },
];

export const OPS_EVALS_SECTIONS: OpsSection[] = [
  { id: 'ops-evals-summary', label: 'Summary' },
  { id: 'ops-evals-what', label: 'What this shows' },
  { id: 'ops-evals-table', label: 'Cases' },
];

// INT-OPS-A / OPS-A.7: the one sentence of a button that cannot work for want of the authenticator code, and the
// one way a PayPal merchant id is written on an operator page: an ellipsis and its last four, or "none".
export const OPS_NEEDS_CODE = 'needs your authenticator code';
export const maskedMerchant = (last4: string | null): string =>
  last4 === null || last4 === '' ? 'none' : `…${last4.slice(-4)}`;
