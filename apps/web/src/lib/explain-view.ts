// INT-GA / GA.4: the logic of the explain panel. Pure. The two texts are plain strings cut at 400 characters (the
// panel prints them as text, never as HTML). The one button is a link to the AL catalogue fix of the chosen alert
// kind, `fix.route#anchor`, with the route passed through lib/next-path.ts; `none`, an unknown kind, a route that is
// not a same-site path or an anchor that is not a plain id gives no button. The panel never posts.
import { safeNext } from './next-path';

export const EXPLAIN_TEXT_MAX = 400;
export const EXPLAIN_TITLE = 'What happened to this order';
export const EXPLAIN_SAFE = 'What is safe to do now';
export const EXPLAIN_NOTE =
  'Written by a model from the order steps and alert kinds only. Check it against the timeline.';

export interface ExplainPanelView {
  what_happened: string;
  safe_now: string;
  button: { href: string; label: string } | null;
}

const cut = (s: string): string => Array.from(s).slice(0, EXPLAIN_TEXT_MAX).join('');
const ANCHOR = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function explainPanelView(
  answer: { what_happened: string; safe_now: string; action_id: string },
  fixes: Readonly<Record<string, { route: string; anchor: string }>>,
): ExplainPanelView {
  const fix = answer.action_id === 'none' ? undefined : fixes[answer.action_id];
  let button: ExplainPanelView['button'] = null;
  if (fix !== undefined) {
    const route = safeNext(fix.route);
    if (route === fix.route && route !== '/' && ANCHOR.test(fix.anchor))
      button = { href: `${route}#${fix.anchor}`, label: 'Open the fix page' };
  }
  return { what_happened: cut(answer.what_happened), safe_now: cut(answer.safe_now), button };
}
