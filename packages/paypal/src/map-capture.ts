import { ProviderOrderIdSchema } from '@umsbx/contracts';
import type { CaptureRes, ClaimUnit } from '@umsbx/contracts';
import { mapError } from './errors';
import { debugIdOf, isRecord } from './headers';
import type { Http, Mapped } from './shapes';
import { latestCapture, purchaseUnits, readCapture, referenceOf } from './map-order';

const unreadable: CaptureRes = { kind: 'unavailable', retry_after_ms: null };

function claimUnits(body: unknown): { units: ClaimUnit[]; notes: string[] } | null {
  const raw = purchaseUnits(body);
  if (raw === null) return null;
  const units: ClaimUnit[] = [];
  const notes: string[] = [];
  for (const u of raw) {
    const reference_id = referenceOf(u);
    if (reference_id === null) return null;
    const latest = latestCapture(u);
    if (latest === undefined) {
      units.push({ reference_id, capture_id: null, status: null });
      continue;
    }
    const c = readCapture(latest);
    if (c === null) return null;
    notes.push(...c.notes);
    units.push({ reference_id, capture_id: c.part.capture_id, status: c.part.status });
  }
  return { units, notes };
}

/**
 * 200, 201 and 207 are claims with one entry per purchase unit; 202 is a claim with the units
 * known so far (possibly none). A claim is not evidence: payments reads back.
 */
export function mapCapture(h: Http, requestedId: string): Mapped<CaptureRes> {
  const { status } = h;
  if (status !== 200 && status !== 201 && status !== 202 && status !== 207) {
    return {
      result: status >= 200 && status <= 299 ? unreadable : mapError(status, h.body, h.headers),
    };
  }
  const body = h.body;
  const idParsed = isRecord(body) ? ProviderOrderIdSchema.safeParse(body.id) : null;
  const provider_order_id = idParsed?.success ? idParsed.data : status === 202 ? requestedId : null;
  const mapped = claimUnits(body);
  if (provider_order_id === null || (mapped === null && status !== 202)) {
    return { result: unreadable, notes: ['malformed_response'] };
  }
  return {
    result: {
      kind: 'claim',
      http: status,
      provider_order_id,
      units: mapped?.units ?? [],
      debug_id: debugIdOf(h.headers, body),
    },
    notes: mapped?.notes ?? [],
  };
}
