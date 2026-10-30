// AI-A (D-067). A ModelPort over the Claude messages API, for brief_parse and pack_compose only.
// It never sees PayPal data and sends no tools. It is built around two ports: a ModelWire (the only way
// out, one host, owned by packages/transport and injected by composition) and a ModelSpendStore.
// On ANY error, refusal, cap, oversize input or answer that does not fit its schema, the scripted model
// answers instead, so the reader gets the same safe result as with the adapter off.
import type {
  Clock,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelSpendStore,
  ModelWire,
} from '@umsbx/contracts';
import {
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  createSpendGuard,
  estimateInputTokens,
  worstCaseMicroUsd,
} from './caps';
import { parseBrief } from './parse-brief';
import { BriefParseOutputSchema, ComposeInputSchema, MAX_BRIEF_CHARS } from './schemas';
import { sanitiseModelOutput } from './tools';

export const CLAUDE_MODEL_ID = 'claude-haiku-5-5';

export interface ClaudeModelDeps {
  wire: ModelWire;
  spend: ModelSpendStore;
  clock: Clock;
  /** The scripted model: answers whenever the Claude path declines or fails. */
  fallback: ModelPort;
  /**
   * Kill switch: false (or a rejection) means no charge and no call, and the scripted model answers.
   * Composition wires it to the paypal_outbound switch, so one stop ends AI calls too.
   */
  live: () => Promise<boolean>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

// One code fence around the JSON is tolerated; any other text around it is not.
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;
function parseAnswerText(text: string): unknown {
  const t = text.trim();
  const m = FENCE.exec(t);
  return JSON.parse(m === null ? t : m[1]!);
}

interface Checked {
  userText: string;
  /** Offer ids the answer may pick (pack_compose), or null. */
  ids: Set<string> | null;
  /** The reader text (brief_parse), or null. */
  raw: string | null;
}

/** The request the adapter is willing to send, or null: the scripted model then answers (and errors) alone. */
function check(request: ModelRequest): Checked | null {
  const input = request.input;
  if (request.purpose === 'brief_parse') {
    if (!isRecord(input) || Object.keys(input).join() !== 'raw_text') return null;
    const raw = input['raw_text'];
    if (typeof raw !== 'string' || raw.length > MAX_BRIEF_CHARS) return null;
    return { userText: JSON.stringify(input), ids: null, raw };
  }
  if (request.purpose === 'pack_compose') {
    const parsed = ComposeInputSchema.safeParse(input);
    if (!parsed.success) return null;
    return {
      userText: JSON.stringify(input),
      ids: new Set(parsed.data.candidates.map((c) => c.offer_id)),
      raw: null,
    };
  }
  return null;
}

/** The answer text and usage of a good envelope, or null. */
// AI-H: the `model` field of the answer, when it is a plain id; anything else is not copied.
const PLAIN_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function readEnvelope(
  body: string,
): { text: string; input_tokens: number; output_tokens: number; served_model: string } | null {
  let env: unknown;
  try {
    env = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(env) || env['stop_reason'] !== 'end_turn') return null;
  const content = env['content'];
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block: unknown = content[0];
  if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string')
    return null;
  const usage = env['usage'];
  if (!isRecord(usage) || !nonNegInt(usage['input_tokens']) || !nonNegInt(usage['output_tokens']))
    return null;
  return {
    text: block['text'],
    input_tokens: usage['input_tokens'],
    output_tokens: usage['output_tokens'],
    served_model:
      typeof env['model'] === 'string' && PLAIN_MODEL_ID.test(env['model'])
        ? env['model']
        : CLAUDE_MODEL_ID,
  };
}

export function createClaudeModel(deps: ClaudeModelDeps): ModelPort {
  const guard = createSpendGuard(deps.spend, deps.clock);

  async function attempt(request: ModelRequest): Promise<ModelResponse | null> {
    const checked = check(request);
    if (checked === null) return null;
    const chars = request.system.length + checked.userText.length;
    const tokens = estimateInputTokens(chars);
    if (tokens > MAX_INPUT_TOKENS) return null;

    const body = JSON.stringify({
      model: CLAUDE_MODEL_ID,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: request.system,
      messages: [{ role: 'user', content: checked.userText }],
    });
    // Stopped by the operator: nothing is charged and nothing is sent.
    if (!(await deps.live())) return null;
    // The worst case is charged first; a refused charge sends nothing.
    if (!(await guard.reserve(worstCaseMicroUsd(tokens), `${request.purpose} est_in ${tokens}`)))
      return null;

    const answer = await deps.wire.send(body);
    if (answer.status !== 200) return null;
    const env = readEnvelope(answer.body);
    if (env === null) return null;
    const raw: unknown = parseAnswerText(env.text);

    if (checked.ids === null) {
      const parsed = BriefParseOutputSchema.safeParse(raw);
      if (!parsed.success) return null;
      // The budget and its currency must be exactly what the reader's own words state, so the model can
      // neither add, drop nor change a number (the deterministic parser is the reference).
      const stated = parseBrief(checked.raw ?? '');
      if (
        parsed.data.ceiling_minor !== stated.ceiling_minor ||
        parsed.data.currency !== stated.currency
      )
        return null;
      return { kind: 'ok', output: parsed.data, ...usageOf(env) };
    }
    const clean = sanitiseModelOutput(raw, checked.ids);
    if (!clean.ok) return null;
    return { kind: 'ok', output: clean.value, ...usageOf(env) };
  }

  return {
    model_id: CLAUDE_MODEL_ID,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      try {
        const out = await attempt(request);
        if (out !== null) return out;
      } catch {
        // Any failure (timeout, network, bad JSON) is handled the same way: the scripted model answers.
      }
      try {
        return await deps.fallback.complete(request);
      } catch {
        return { kind: 'error', reason: 'model_error' };
      }
    },
  };
}

const usageOf = (e: { input_tokens: number; output_tokens: number; served_model: string }) => ({
  input_tokens: e.input_tokens,
  output_tokens: e.output_tokens,
  served_model: e.served_model,
});
