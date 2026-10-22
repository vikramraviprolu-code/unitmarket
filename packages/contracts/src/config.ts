import { z } from 'zod';
import { SecretSchema } from './ports';

const ms = z.number().int().nonnegative();
// https origin with no path, userinfo, query or fragment, or http://localhost[:port] for offline mode.
const originPattern =
  /^(?:https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?|http:\/\/localhost(?::\d{1,5})?)$/;
const portInRange = (origin: string) => {
  const port = /:(\d+)$/.exec(origin)?.[1];
  return port === undefined || Number(port) <= 65535;
};

export const DomainConfigSchema = z
  .object({
    /** 86400000 */
    reconcile_window_ms: ms,
    /** [30000, 120000, 600000, 3600000] */
    reconcile_backoff_ms: z.array(ms).min(1).readonly(),
    /** 18000000 (5 h; PayPal keeps request ids 6 h) */
    idem_safe_window_ms: ms.max(18_000_000),
    /** 86400000 */
    abandoned_checkout_ms: ms,
    /** 60000 */
    operation_lease_ms: ms,
    /** 1 */
    max_capture_retries: ms.max(1),
    /** 600000 */
    link_ttl_ms: ms,
    public_origin: z.string().regex(originPattern).refine(portInRange, 'port out of range'),
    approval_secret: SecretSchema,
    link_secret: SecretSchema,
    rule_version: z.string().min(1),
    pricing_rule_version: z.string().min(1),
  })
  .strict();
export type DomainConfig = z.infer<typeof DomainConfigSchema>;
