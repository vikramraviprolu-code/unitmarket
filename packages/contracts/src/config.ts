import { z } from 'zod';
import { SecretSchema } from './ports';

const ms = z.number().int().nonnegative();
// https origin with no path, or http://localhost[:port] for offline mode.
const originPattern = /^(?:https:\/\/[^/\s]+|http:\/\/localhost(?::\d{1,5})?)$/;

export const DomainConfigSchema = z
  .object({
    /** 86400000 */
    reconcile_window_ms: ms,
    /** [30000, 120000, 600000, 3600000] */
    reconcile_backoff_ms: z.array(ms).min(1).readonly(),
    /** 18000000 (5 h; PayPal keeps request ids 6 h) */
    idem_safe_window_ms: ms,
    /** 86400000 */
    abandoned_checkout_ms: ms,
    /** 60000 */
    operation_lease_ms: ms,
    /** 1 */
    max_capture_retries: ms,
    /** 600000 */
    link_ttl_ms: ms,
    public_origin: z.string().regex(originPattern),
    approval_secret: SecretSchema,
    link_secret: SecretSchema,
    rule_version: z.string().min(1),
    pricing_rule_version: z.string().min(1),
  })
  .strict();
export type DomainConfig = z.infer<typeof DomainConfigSchema>;
