// API-B (G2, G3): what the public API shows of a mandate. The domain row names its buyer; the public view
// does not (the caller is that buyer). Parsed through the contract, so a stray field cannot leak.
import { MandateViewSchema } from '@umsbx/contracts';
import type { MandateView } from '@umsbx/contracts';

export function publicMandate(row: MandateView & { buyer_id?: string }): MandateView {
  const { buyer_id, ...rest } = row;
  void buyer_id;
  return MandateViewSchema.parse(rest);
}
