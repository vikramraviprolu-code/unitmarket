// INT-AL AL.8: how an alert or case error code becomes an HTTP answer for the operator routes. The words are
// plain and name no identity, no PayPal id and no amount.
import type { HttpResult } from '@umsbx/security';

const ALERT_TEXT: Record<string, string> = {
  not_found: 'We could not find that alert.',
  wrong_state: 'This alert is not in a state where that can be done.',
  bad_input: 'That reason or note is not accepted.',
};
const CASE_TEXT: Record<string, string> = {
  not_found: 'We could not find that case.',
  wrong_state: 'This case is not in a state where that can be done.',
  not_operator: 'Only an operator can do that.',
  not_owner: 'Only an operator can do that.',
  duplicate_open: 'A case for this item is already open.',
  bad_input: 'That reason or credit is not accepted.',
};

function map(code: string, text: Record<string, string>): HttpResult<unknown> {
  const message = text[code] ?? 'That could not be done.';
  switch (code) {
    case 'not_found':
      return { status: 404, code, message };
    case 'wrong_state':
    case 'duplicate_open':
      return { status: 409, code, message };
    case 'bad_input':
      return { status: 422, code, message };
    default:
      return { status: 403, code: 'forbidden', message };
  }
}

export const alertErrorResult = (code: string): HttpResult<unknown> => map(code, ALERT_TEXT);
export const caseActionErrorResult = (code: string): HttpResult<unknown> => map(code, CASE_TEXT);
