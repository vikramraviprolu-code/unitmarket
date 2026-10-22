// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/receipts/html.ts. Adapted; owned by SBX.
// Receipt page: every value is escaped; no script, no inline handler, no external resource. The
// label comes from the stored environment (P16), never from a literal chosen by the caller's mood.
import { minorUnitsFor } from '@umsbx/approval';
import type { EnvironmentLabel, Receipt } from '@umsbx/contracts';

export function receiptLabel(environment: EnvironmentLabel): 'Dry run' | 'Sandbox' {
  return environment === 'sandbox' ? 'Sandbox' : 'Dry run';
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};
const esc = (value: unknown): string => String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);

function money(minor: number, currency: string): string {
  const digits = minorUnitsFor(currency);
  if (digits === null) return `${esc(minor)} minor units ${esc(currency)}`;
  if (digits === 0) return `${esc(minor)} ${esc(currency)}`;
  const text = String(minor).padStart(digits + 1, '0');
  return `${esc(text.slice(0, -digits))}.${esc(text.slice(-digits))} ${esc(currency)}`;
}

// "sent" means the server finished sending, not that a device saved the file (architecture 9.4).
const DELIVERY_TEXT: Record<string, string> = {
  access_ready: 'Access ready',
  link_issued: 'Link issued',
  download_completed: 'Sent (the server finished sending; this does not show a device saved it)',
  download_aborted: 'Sending was interrupted',
  reader_rendered: 'Page sent to the reader',
  reader_beacon: 'Reader signal (reported by the browser, not verified)',
  delivery_failed: 'Delivery failed',
  delivery_restored: 'Delivery restored',
  credit_granted: 'Time credit granted',
  window_ended: 'Access window ended',
  revoked: 'Access revoked',
};

/**
 * The label is derived from the receipt's own environment. A caller may pass one; a label that
 * contradicts the environment is refused, so a dry run can never read "Sandbox" or the reverse.
 */
export function renderReceiptHtml(r: Receipt, label?: 'Dry run' | 'Sandbox'): string {
  const derived = receiptLabel(r.environment);
  if (label !== undefined && label !== derived) {
    throw new Error(`receipt label "${label}" contradicts environment ${r.environment}`);
  }
  label = derived;
  const cur = r.snapshot.currency;
  const lines = r.lines
    .map((l) => {
      const w = l.window;
      const delivery =
        l.delivery.length === 0
          ? '<li>No delivery events yet</li>'
          : l.delivery
              .map((e) => `<li>${esc(DELIVERY_TEXT[e.kind] ?? e.kind)} at ${esc(e.at)}</li>`)
              .join('');
      return `<section>
<h3>Article ${esc(l.article_id)}</h3>
<dl>
<dt>Option</dt><dd>${esc(l.option)}</dd>
<dt>Amount</dt><dd>${money(l.amount_minor, cur)}</dd>
<dt>Article sha256</dt><dd><code>${esc(l.article_sha256)}</code></dd>
<dt>Capture id</dt><dd>${l.capture_id === null ? 'not captured' : esc(l.capture_id)}</dd>
<dt>Access window</dt><dd>${esc(w.state)}; started ${esc(w.started_at ?? 'not yet')}; ends ${esc(w.ends_at ?? 'not set')}; credit ${esc(w.credit_ms)} ms</dd>
</dl>
<ul>${delivery}</ul>
</section>`;
    })
    .join('\n');
  const refunds =
    r.refunds.length === 0
      ? '<p>No refunds.</p>'
      : `<ul>${r.refunds
          .map(
            (x) =>
              `<li>${esc(x.refund_id)}: ${money(x.amount.minor, x.amount.currency)} at ${esc(x.at)}</li>`,
          )
          .join('')}</ul>`;
  const debug =
    r.debug_ids.length === 0 ? 'none' : r.debug_ids.map((x) => `<code>${esc(x)}</code>`).join(' ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(r.order_id)} version ${esc(r.version)}</title>
</head>
<body>
<p><strong>${esc(label)}</strong></p>
<h1>Receipt</h1>
<dl>
<dt>Order</dt><dd>${esc(r.order_id)}</dd>
<dt>Version</dt><dd>${esc(r.version)}</dd>
<dt>Issued</dt><dd>${esc(r.created_at)}</dd>
<dt>Total</dt><dd>${money(r.snapshot.total_minor, cur)}</dd>
<dt>Approved offer hash</dt><dd><code>${esc(r.content_hash)}</code></dd>
<dt>Receipt sha256</dt><dd><code>${esc(r.sha256)}</code></dd>
<dt>PayPal debug ids (last 6)</dt><dd>${debug}</dd>
</dl>
<h2>Items</h2>
${lines}
<h2>Refunds</h2>
${refunds}
</body>
</html>
`;
}
