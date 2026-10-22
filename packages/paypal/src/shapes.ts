// Small shared types for the response mappers.
export interface Http {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  body: unknown;
}
export interface Mapped<T> {
  result: T;
  /** Short facts for the call record, e.g. `refunded_source=none`. */
  notes?: string[];
}
