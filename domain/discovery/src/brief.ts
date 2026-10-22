// parseNeed: a buyer's free text becomes a stored, structured Brief through the model port.
// What the model sees is the redacted text only (PRIV-2); its answer is zod-parsed before use (AI-5).
// Brief parsing idea adapted from AIC_Hackathon_UnitMarket simulation/consumers/src/parse.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90 via packages/model (lane 13). Owned by SBX.
import { BriefSchema, err, ok } from '@umsbx/contracts';
import type { Actor, AgentDeps, Brief, Result } from '@umsbx/contracts';
// CHANGE-REQUEST-S1: eslint S1 bars @umsbx/model from domain/*, but architecture 2.3 S4 and lane 14b name it as
// an allowed dependency of discovery (BRIEF_SYSTEM, schemas, sanitiseModelOutput). Disabled per line until the
// lane 00 rule is amended.

import { BRIEF_SYSTEM, BriefParseOutputSchema } from '@umsbx/model';

export const MAX_BRIEF_CHARS = 2000;
export type ParseNeedError = { code: 'too_long' | 'unparseable' | 'model_error' | 'not_buyer' };

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
// Control characters (NUL cannot be stored in text columns) become spaces; lone surrogates are repaired.
function stripControl(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const lone = c >= 0xd800 && c <= 0xdfff;
    const keep = !lone && (c === 0x09 || c === 0x0a || c === 0x0d || (c > 0x1f && c !== 0x7f));
    out += keep ? ch : ' ';
  }
  return out;
}
const fail = (code: ParseNeedError['code']) => err<ParseNeedError>({ code });

export async function parseNeed(
  d: AgentDeps,
  i: { actor: Actor; text: string },
): Promise<Result<Brief, ParseNeedError>> {
  if (i.actor.kind !== 'buyer') return fail('not_buyer');
  const buyerId = i.actor.buyer_id;
  const buyer = await d.db.query('SELECT 1 AS x FROM buyers WHERE id = $1', [buyerId]);
  if (buyer.rows.length === 0) return fail('not_buyer');

  // AI-4: refuse before any model call.
  if (typeof i.text !== 'string' || i.text.length > MAX_BRIEF_CHARS) return fail('too_long');

  // PRIV-2: the model gets the need text and nothing else; an email typed into it is removed.
  const text = stripControl(i.text);
  const raw_text = text.replace(EMAIL, '[redacted]');
  let response;
  try {
    response = await d.model.complete({
      purpose: 'brief_parse',
      system: BRIEF_SYSTEM,
      input: { raw_text },
    });
  } catch {
    return fail('model_error');
  }
  if (response.kind === 'error')
    return fail(response.reason === 'too_long' ? 'too_long' : 'model_error');

  const parsed = BriefParseOutputSchema.safeParse(response.output);
  if (!parsed.success) return fail('unparseable');
  const p = parsed.data;
  // A stated amount without a currency is not guessed.
  if (p.ceiling_minor !== null && p.currency === null) return fail('unparseable');

  const now = d.clock.now().toISOString();
  const candidate = {
    brief_id: d.ids.next('brf'),
    buyer_id: buyerId,
    need: p.need,
    ceiling:
      p.ceiling_minor !== null && p.currency !== null
        ? { currency: p.currency, minor: p.ceiling_minor }
        : null,
    option: p.option,
    language: p.language,
    terms: p.terms,
    created_at: now,
  };
  const checked = BriefSchema.safeParse(candidate);
  if (!checked.success) return fail('unparseable');
  const brief = checked.data;

  await d.db.query(
    `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$6)`,
    [
      brief.brief_id,
      brief.buyer_id,
      text,
      JSON.stringify({
        need: brief.need,
        ceiling: brief.ceiling,
        option: brief.option,
        language: brief.language,
        terms: brief.terms,
      }),
      d.model.model_id,
      now,
    ],
  );
  return ok(brief);
}
