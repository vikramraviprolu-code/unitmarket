// TEMP-until-lane-01: exact interface text from docs/design/lanes/01-contracts.md (F1).
// Delete this file and import from '@umsbx/contracts' once lane 01 F1 is on main.
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export type ModelPurpose = 'brief_parse' | 'pack_compose';
export interface ModelRequest {
  purpose: ModelPurpose;
  system: string;
  input: unknown;
}
export type ModelResponse =
  | { kind: 'ok'; output: unknown; input_tokens: number; output_tokens: number }
  | { kind: 'error'; reason: string };
export interface ModelPort {
  readonly model_id: string;
  complete(r: ModelRequest): Promise<ModelResponse>;
}
