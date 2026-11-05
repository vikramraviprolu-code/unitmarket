// INT-GA: the chip set a plain-words search builds up. One place says how a field is placed for a role: a field the
// role table (REFUSED_FIELDS, SR0) refuses is never a chip, it is named in `dropped`; a comma-list field collects
// values in the order they were met; any other field keeps its first value.
import { REFUSED_FIELDS } from '@umsbx/contracts';

export type AssistRole = keyof typeof REFUSED_FIELDS;

/** Fields whose URL value is a comma list (SR0's "any of these"). */
export const LIST_FIELDS: ReadonlySet<string> = new Set([
  'currency',
  'status',
  'refund',
  'case',
  'flags',
]);

export class ChipSet {
  readonly chips: Record<string, string> = {};
  readonly dropped: string[] = [];
  private readonly role: AssistRole;
  constructor(role: AssistRole) {
    this.role = role;
  }

  refused(field: string): boolean {
    return REFUSED_FIELDS[this.role].includes(field);
  }

  drop(field: string): void {
    if (!this.dropped.includes(field)) this.dropped.push(field);
  }

  /** Place a value; a refused field is dropped instead. */
  place(field: string, value: string): void {
    if (this.refused(field)) {
      this.drop(field);
      return;
    }
    const had = this.chips[field];
    if (had === undefined) this.chips[field] = value;
    else if (LIST_FIELDS.has(field) && !had.split(',').includes(value))
      this.chips[field] = `${had},${value}`;
  }

  has(field: string): boolean {
    return this.chips[field] !== undefined;
  }
}
