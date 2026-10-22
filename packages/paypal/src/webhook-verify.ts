import type { WebhookVerdict } from '@umsbx/contracts';

// TODO(MVP-C): verify the signature locally (architecture 9.1: raw body capped at 64 KB, the five
// paypal-* headers, allow-listed certificate URL fetched through Transport as fetch_webhook_cert,
// message `id|time|webhook_id|crc32(raw)`, SHA256 verify). Until then nothing is trusted: the
// verdict is always `unverifiable`, which the route answers with 503 and never as a forgery.
// The port passes ({ headers, raw_body }); the MVP-A stub ignores both, so it takes no parameter.
export async function verifyWebhook(): Promise<WebhookVerdict> {
  return { kind: 'unverifiable' };
}
