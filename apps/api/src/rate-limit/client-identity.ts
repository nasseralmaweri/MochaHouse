import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import type { ClientIpMode } from './rate-limit.config';

// R1 / S3a — who is calling, as far as rate limiting may trust.
//
// The client IP is only ever taken from (a) a request header SIGNED with a
// secret shared between the web tier and this API, or (b) the connection's
// peer address as Express resolves it from the `trust proxy` setting in
// main.ts. A raw X-Forwarded-For (or any other unsigned header) is NEVER read,
// so a caller cannot choose their own rate-limit bucket.
//
// The signed header exists because the web app's server actions and proxy
// routes call this API from the web server: without it the API would see one
// client (the web server) for every proxied customer. It is an ordinary
// HMAC-SHA256 over "<seconds>.<ip>" with a short validity window; it adds no
// new protocol and carries nothing but the IP the web tier itself trusts.

export const CLIENT_IP_HEADER = 'x-centerivo-client-ip';
export const CLIENT_IP_TIMESTAMP_HEADER = 'x-centerivo-client-ts';
export const CLIENT_IP_SIGNATURE_HEADER = 'x-centerivo-client-sig';

// How far the signed timestamp may differ from this server's clock.
export const CLIENT_IP_MAX_SKEW_SECONDS = 60;

export function signClientIp(
  secret: string,
  ip: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(`${timestampSeconds}.${ip}`)
    .digest('hex');
}

// Validates an address and puts it in the form used as a rate-limit key:
// lower case, IPv4-mapped IPv6 reduced to IPv4, and IPv6 collapsed to its /64
// (a single customer can rotate through a whole /64, so the address itself
// would be a bypass). Returns null for anything that is not an IP address.
export function normalizeClientIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (value === '' || value.length > 64) return null;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) {
    value = value.slice(7);
  }
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind === 6) {
    // Expand to eight hextets, keep the first four.
    const [head, tail = ''] = value.split('::');
    const headParts = head === '' ? [] : head.split(':');
    const tailParts = tail === '' ? [] : tail.split(':');
    const missing = value.includes('::')
      ? 8 - headParts.length - tailParts.length
      : 0;
    const full = [
      ...headParts,
      ...Array.from({ length: Math.max(missing, 0) }, () => '0'),
      ...tailParts,
    ].slice(0, 8);
    if (full.length !== 8) return null;
    // IPv4-mapped IPv6 written in hex (::ffff:c000:204) is the IPv4 address.
    if (
      full.slice(0, 5).every((h) => /^0+$/.test(h)) &&
      full[5] === 'ffff' &&
      /^[0-9a-f]{1,4}$/.test(full[6]) &&
      /^[0-9a-f]{1,4}$/.test(full[7])
    ) {
      const high = Number.parseInt(full[6], 16);
      const low = Number.parseInt(full[7], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return `${full
      .slice(0, 4)
      .map((hextet) => hextet.replace(/^0+(?=.)/, ''))
      .join(':')}::/64`;
  }
  return null;
}

type HeaderBag = Record<string, string | string[] | undefined>;

function single(headers: HeaderBag, name: string): string | null {
  const value = headers[name];
  if (typeof value === 'string') return value;
  return null;
}

// The IP carried by a valid signed header, or null. Constant-time signature
// comparison; the timestamp must be fresh (past and future); the IP must be a
// real address. Any problem yields null — the caller then falls back to the
// peer address, never to a guess.
export function verifyForwardedClientIp(input: {
  headers: HeaderBag;
  secret: string | null;
  nowSeconds: number;
}): string | null {
  if (input.secret === null) return null;
  const ip = single(input.headers, CLIENT_IP_HEADER);
  const timestamp = single(input.headers, CLIENT_IP_TIMESTAMP_HEADER);
  const signature = single(input.headers, CLIENT_IP_SIGNATURE_HEADER);
  if (ip === null || timestamp === null || signature === null) return null;
  if (!/^\d{1,12}$/.test(timestamp)) return null;
  const seconds = Number(timestamp);
  if (Math.abs(input.nowSeconds - seconds) > CLIENT_IP_MAX_SKEW_SECONDS) {
    return null;
  }
  if (isIP(ip.trim()) === 0) return null;

  const expected = Buffer.from(
    signClientIp(input.secret, ip.trim(), seconds),
    'hex',
  );
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  return normalizeClientIp(ip);
}

export interface ResolvedClientIp {
  // The key-ready address, or null when per-IP limiting is not possible.
  readonly ip: string | null;
  readonly source: 'forwarded' | 'peer' | 'none';
}

export function resolveClientIp(input: {
  request: Pick<Request, 'headers' | 'ip' | 'socket'>;
  mode: ClientIpMode;
  secret: string | null;
  nowSeconds: number;
}): ResolvedClientIp {
  if (input.mode === 'off') return { ip: null, source: 'none' };

  if (input.mode === 'forwarded') {
    const forwarded = verifyForwardedClientIp({
      headers: input.request.headers,
      secret: input.secret,
      nowSeconds: input.nowSeconds,
    });
    if (forwarded !== null) return { ip: forwarded, source: 'forwarded' };
  }

  // `request.ip` follows Express "trust proxy" (main.ts). Never a raw header.
  const peer = normalizeClientIp(
    input.request.ip ?? input.request.socket?.remoteAddress,
  );
  return peer === null
    ? { ip: null, source: 'none' }
    : { ip: peer, source: 'peer' };
}

// Identifiers (an email, a username) are never written into Redis keys as
// typed. They are normalised so trivial variations cannot mint a fresh bucket,
// then hashed.
export function normalizeIdentifier(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.normalize('NFKC').trim().toLowerCase();
  if (value === '' || value.length > 320) return null;
  return value;
}

export function hashIdentifier(
  raw: unknown,
  pepper: string | null,
): string | null {
  const normalised = normalizeIdentifier(raw);
  if (normalised === null) return null;
  return createHash('sha256')
    .update(`${pepper ?? 'centerivo-rate-limit'}\u0000${normalised}`)
    .digest('hex')
    .slice(0, 32);
}
