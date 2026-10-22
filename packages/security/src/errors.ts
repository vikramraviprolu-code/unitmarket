// Error bodies. Users get a code, a short fixed message and a support code; details go to logs.
export interface ErrorBody {
  error: { code: string; message: string; support_code: string; fields?: string[] };
}

export const supportCode = (req_id: string): string => `E-${req_id.slice(0, 8)}`;

export function errorBody(
  code: string,
  message: string,
  req_id: string,
  fields?: string[],
): ErrorBody {
  const error: ErrorBody['error'] = { code, message, support_code: supportCode(req_id) };
  if (fields !== undefined) error.fields = fields;
  return { error };
}

export const GENERIC_MESSAGE =
  'Something went wrong on our side. Quote the support code if you contact us.';

interface IssueLike {
  code?: string;
  path?: readonly PropertyKey[];
  keys?: readonly string[];
}

// Field names only: never the values and never zod's message text (it can echo input).
export function fieldNames(issues: readonly IssueLike[]): string[] {
  const out = new Set<string>();
  for (const i of issues) {
    const prefix = (i.path ?? []).map(String);
    if (i.code === 'unrecognized_keys' && i.keys !== undefined) {
      for (const k of i.keys) out.add([...prefix, k].join('.'));
    } else {
      out.add(prefix.length > 0 ? prefix.join('.') : '_body');
    }
  }
  return [...out].slice(0, 50);
}
