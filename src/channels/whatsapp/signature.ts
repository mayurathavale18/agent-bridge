import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * OpenWA signs each delivery with `X-OpenWA-Signature: sha256=<hex>` where the digest is
 * HMAC-SHA256 of the RAW request body under the webhook's secret. Verify against the raw
 * bytes — re-serializing the parsed JSON would change the digest.
 */
export function computeSignature(secret: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Constant-time comparison of the expected and received signatures. */
export function verifySignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(computeSignature(secret, rawBody));
  const received = Buffer.from(header);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
