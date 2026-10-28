/**
 * Webhook signatures, spec §10.3. Upstream signatures are verified against the raw body
 * before translation; translated payloads are re-signed with the Standard Webhooks scheme
 * (https://www.standardwebhooks.com) so downstream services can verify the proxy.
 */

const enc = new TextEncoder();

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const k = await globalThis.crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex HMAC of body>`. */
export async function verifyGitHub(secret: string, body: string, header: string | null | undefined): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  return timingSafeEqual(header.slice(7), toHex(await hmac(enc.encode(secret), body)));
}

/** Stripe: `Stripe-Signature: t=<unix>,v1=<hex HMAC of "t.body">`, with a replay tolerance. */
export async function verifyStripe(secret: string, body: string, header: string | null | undefined, toleranceSec = 300, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = toHex(await hmac(enc.encode(secret), `${t}.${body}`));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

/** Generic: hex or base64 HMAC-SHA256 of the raw body in a configurable header. */
export async function verifyHmacSha256(secret: string, body: string, header: string | null | undefined, encoding: 'hex' | 'base64' = 'hex', prefix = ''): Promise<boolean> {
  if (!header?.startsWith(prefix)) return false;
  const mac = await hmac(enc.encode(secret), body);
  return timingSafeEqual(header.slice(prefix.length), encoding === 'hex' ? toHex(mac) : toB64(mac));
}

function swKey(secret: string): Uint8Array {
  return fromB64(secret.startsWith('whsec_') ? secret.slice(6) : secret);
}

/** Standard Webhooks signature header value: `v1,<base64 HMAC of "id.timestamp.body">`. */
export async function signStandardWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  return 'v1,' + toB64(await hmac(swKey(secret), `${id}.${timestamp}.${body}`));
}

export async function verifyStandardWebhook(secret: string, id: string, timestamp: number, body: string, header: string, toleranceSec = 300, now = Date.now()): Promise<boolean> {
  if (Math.abs(now / 1000 - timestamp) > toleranceSec) return false;
  const expected = await signStandardWebhook(secret, id, timestamp, body);
  return header.split(' ').some((s) => timingSafeEqual(s, expected));
}
