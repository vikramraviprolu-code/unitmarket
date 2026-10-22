// Adapted from AIC_Hackathon_UnitMarket simulation/consumers/src/model.ts at a36ddc03fd0b962000f686291c145b50ee337f90.
// Deterministic ModelPort: no network, no clock, no randomness, no spend.
import type { ModelPort, ModelRequest, ModelResponse } from './contracts-temp';
import { composePack } from './compose';
import { parseBrief } from './parse-brief';
import { ComposeInputSchema, MAX_BRIEF_CHARS, MAX_CANDIDATES } from './schemas';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (reason: string): ModelResponse => ({ kind: 'error', reason });
const good = (output: unknown): ModelResponse => ({
  kind: 'ok',
  output,
  input_tokens: 0,
  output_tokens: 0,
});

export function createScriptedModel(): ModelPort {
  return {
    model_id: 'scripted-v1',
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const { input } = request;
      if (!isRecord(input)) return fail('invalid_input');
      if (request.purpose === 'brief_parse') {
        if (typeof input['raw_text'] !== 'string') return fail('invalid_input');
        if (input['raw_text'].length > MAX_BRIEF_CHARS) return fail('too_long');
        return good(parseBrief(input['raw_text']));
      }
      if (request.purpose === 'pack_compose') {
        const c = input['candidates'];
        if (Array.isArray(c) && c.length > MAX_CANDIDATES) return fail('too_many_candidates');
        const parsed = ComposeInputSchema.safeParse(input);
        return parsed.success ? good(composePack(parsed.data)) : fail('invalid_input');
      }
      return fail('unsupported_purpose');
    },
  };
}
