// The tool dispatcher knows three read-only tools and never executes any of them (AI-3).
// sanitiseModelOutput is the only way model output enters the system (AI-5).
import { AGENT_TOOLS } from './prompts';
import { ComposeOutputSchema } from './schemas';
import type { ComposeOutput } from './schemas';
import { err, ok } from './contracts-temp';
import type { Result } from './contracts-temp';

const ALLOWED: readonly string[] = AGENT_TOOLS;
const FORBIDDEN_KEY = /price|payee|payer|amount|total|cents|minor|approval|email|secret|token/i;

export function dispatchTool(call: { tool: string; args: Record<string, unknown> }): {
  accepted: boolean;
  recorded: true;
} {
  // args is never read, called or serialised here.
  return { accepted: typeof call.tool === 'string' && ALLOWED.includes(call.tool), recorded: true };
}

function strip(v: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !FORBIDDEN_KEY.test(k))
        .map(([k, x]) => [k, strip(x, depth + 1)]),
    );
  }
  return v;
}

export function sanitiseModelOutput(
  raw: unknown,
  candidateIds: Set<string>,
): Result<ComposeOutput, 'unparseable' | 'unknown_offer'> {
  const parsed = ComposeOutputSchema.safeParse(raw);
  if (!parsed.success) return err('unparseable');
  if (parsed.data.picks.some((p) => !candidateIds.has(p.offer_id))) return err('unknown_offer');
  return ok({
    picks: parsed.data.picks.map((p) => ({ offer_id: p.offer_id, reason: p.reason })),
    tool_calls: parsed.data.tool_calls.map((c) => ({
      tool: c.tool,
      args: strip(c.args) as Record<string, unknown>,
    })),
  });
}
