import { PayPalOperationSchema, err, ok } from '@umsbx/contracts';
import type {
  Actor,
  AuditSink,
  Clock,
  Database,
  Ids,
  PayPalOperation,
  Result,
} from '@umsbx/contracts';

export type TerminalCheck = Result<void, 'not_a_tty' | 'ci_set'>;

// SOP 2: operator CLIs run only from a person's terminal.
export function checkOperatorTerminal(t: {
  isTTY: boolean | undefined;
  env: Record<string, string | undefined>;
}): TerminalCheck {
  if (t.isTTY !== true) return err('not_a_tty');
  const ci = t.env.CI;
  if (ci !== undefined && ci !== '') return err('ci_set');
  return ok(undefined);
}

export interface ApprovalInput {
  approval_ref: string;
  scope: string;
  operations: PayPalOperation[];
  max_amount_minor: number;
  max_calls_per_day: number;
  valid_until: string;
  approved_by: string;
}

export type ApproveError =
  'not_a_tty' | 'ci_set' | 'invalid_input' | 'scope_not_confirmed' | 'duplicate_ref';

// The only code path that inserts an outbound_approvals row (append-only table). The operator
// must type the scope name; a wrong answer writes nothing.
export async function runApprove(d: {
  db: Database;
  clock: Clock;
  ids: Ids;
  audit: AuditSink;
  tty: { isTTY: boolean | undefined; env: Record<string, string | undefined> };
  ask: (prompt: string) => Promise<string>;
  write: (line: string) => void;
  by: Actor;
  input: ApprovalInput;
}): Promise<Result<{ approval_ref: string }, ApproveError>> {
  const term = checkOperatorTerminal(d.tty);
  if (!term.ok) return term;
  const i = d.input;
  const valid =
    i.approval_ref.trim() !== '' &&
    i.scope.trim() !== '' &&
    i.approved_by.trim() !== '' &&
    i.operations.length > 0 &&
    i.operations.every((o) => PayPalOperationSchema.safeParse(o).success) &&
    Number.isInteger(i.max_amount_minor) &&
    i.max_amount_minor >= 0 &&
    Number.isInteger(i.max_calls_per_day) &&
    i.max_calls_per_day >= 0 &&
    !Number.isNaN(Date.parse(i.valid_until)) &&
    Date.parse(i.valid_until) > d.clock.now().getTime();
  if (!valid) return err('invalid_input');
  d.write(
    `Approving ${i.operations.join(', ')} up to ${i.max_amount_minor} minor units, ${i.max_calls_per_day} calls a day, until ${i.valid_until}.`,
  );
  const typed = await d.ask(`Type the scope name (${i.scope}) to confirm: `);
  if (typed.trim() !== i.scope) return err('scope_not_confirmed');
  const dup = await d.db.query('SELECT 1 FROM outbound_approvals WHERE approval_ref = $1', [
    i.approval_ref,
  ]);
  if (dup.rows.length > 0) return err('duplicate_ref');
  const at = d.clock.now().toISOString();
  await d.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        d.ids.next('oap'),
        i.approval_ref,
        i.scope,
        i.operations,
        i.max_amount_minor,
        i.max_calls_per_day,
        i.valid_until,
        i.approved_by,
        at,
      ],
    );
    await d.audit.record(tx, {
      actor: d.by,
      action: 'outbound_approval.create',
      target: null,
      reason: `scope ${i.scope}`,
      detail: { approval_ref: i.approval_ref, scope: i.scope, valid_until: i.valid_until },
    });
  });
  return ok({ approval_ref: i.approval_ref });
}
