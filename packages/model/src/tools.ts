// The tool dispatcher knows three read-only tools and never executes any of them (AI-3).
// sanitiseModelOutput is the only way model output enters the system (AI-5).
import { AGENT_TOOLS } from './prompts';
import { ComposeOutputSchema } from './schemas';
import type { ComposeOutput } from './schemas';
import { err, ok } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';

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

// AI-H. The model's free-text `reason` may one day be shown to a reader, so it is cleaned here first: no
// link, address, price or control character, one line of at most REASON_MAX characters. Removed text becomes
// a space, so removing one piece can never join two others into a new match, and the result is stable when
// cleaned again.
export const REASON_MAX = 160;
const CURRENCY_SIGN = '[$\\u20ac\\u00a3\\u00a5\\u20b9\\u20bd\\u20a9]';
const CURRENCY_WORD =
  '(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY|dollars?|euros?|pounds?|cents?|bucks?)';
const NUMBER = '\\d[\\d.,]*';
const SCRUB: readonly RegExp[] = [
  // Any token holding an at sign (an address, however malformed).
  /\S*@\S*/g,
  // Any token holding a scheme separator, and the schemes that need none.
  /\S*:\/\/\S*/g,
  /\b(?:mailto|data|javascript|vbscript|file|tel|sms):\S*/gi,
  // www. hosts and bare hosts (name.tld, with an optional path).
  /\bwww\.\S*/gi,
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/\S*)?/gi,
  // Digits next to a currency sign or code or word, on either side.
  new RegExp(`${CURRENCY_SIGN}\\s*${NUMBER}`, 'g'),
  new RegExp(`${NUMBER}\\s*${CURRENCY_SIGN}`, 'g'),
  new RegExp(`\\b${CURRENCY_WORD}\\s*${NUMBER}`, 'gi'),
  new RegExp(`${NUMBER}\\s*${CURRENCY_WORD}\\b`, 'gi'),
];
// Control (Cc), format (Cf: zero width and bidi marks), line and paragraph separators, lone surrogates.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

export function scrubReason(text: string): string {
  let out = text.replace(INVISIBLE, ' ');
  for (const re of SCRUB) out = out.replace(re, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return [...out].slice(0, REASON_MAX).join('').trim();
}

export function sanitiseModelOutput(
  raw: unknown,
  candidateIds: Set<string>,
): Result<ComposeOutput, 'unparseable' | 'unknown_offer'> {
  const parsed = ComposeOutputSchema.safeParse(raw);
  if (!parsed.success) return err('unparseable');
  if (parsed.data.picks.some((p) => !candidateIds.has(p.offer_id))) return err('unknown_offer');
  return ok({
    picks: parsed.data.picks.map((p) => ({ offer_id: p.offer_id, reason: scrubReason(p.reason) })),
    tool_calls: parsed.data.tool_calls.map((c) => ({
      tool: c.tool,
      args: strip(c.args) as Record<string, unknown>,
    })),
  });
}
