import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  STOREFRONT_CONTEXT_MAX_SKEW_SECONDS,
  STOREFRONT_HOST_HEADER,
  STOREFRONT_HOST_SIGNATURE_HEADER,
  STOREFRONT_HOST_TIMESTAMP_HEADER,
  normalizeStorefrontHost,
  storefrontContextMessage,
} from '@mocha-house/contracts';

// SC4f-1 — which business a storefront request is for.
//
// Two modes, chosen per deployment by STOREFRONT_HOST_ROUTING_ENABLED:
//
//   off (default) — exactly the behaviour before SC4f: every public request
//       is the deployment's single business (SINGLE_TENANT_ID). Storefront
//       headers, signed or not, are ignored.
//   on            — the business comes ONLY from the approved hostname
//       registry, for the hostname in a storefront context SIGNED by the web
//       tier (HMAC-SHA256 with STOREFRONT_CONTEXT_SECRET, a short validity
//       window, constant-time comparison). An unsigned, invalid or stale
//       context, an unknown hostname or an unpublished one resolves to NO
//       business — never to a default one. A browser cannot sign, so it can
//       never choose its own business.
//
// The secret is separate from CLIENT_IP_FORWARD_SECRET and the signed message
// is domain-separated, so one signature can never stand in for the other.

export const STOREFRONT_HOST_ROUTING_ENV = 'STOREFRONT_HOST_ROUTING_ENABLED';
export const STOREFRONT_CONTEXT_SECRET_ENV = 'STOREFRONT_CONTEXT_SECRET';
const MIN_SECRET_LENGTH = 32;

export interface StorefrontRoutingConfig {
  hostRouting: boolean;
  // Present exactly when hostRouting is on.
  secret: string | null;
}

export const STOREFRONT_ROUTING_CONFIG = Symbol('STOREFRONT_ROUTING_CONFIG');

export class StorefrontRoutingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorefrontRoutingConfigError';
  }
}

// Read once at startup. Host routing switched on without a usable secret
// aborts startup (fail closed) rather than serving without verification.
export function storefrontRoutingConfig(
  env: Record<string, string | undefined> = process.env,
): StorefrontRoutingConfig {
  const flag = (env[STOREFRONT_HOST_ROUTING_ENV] ?? '').trim().toLowerCase();
  if (flag === '' || flag === '0' || flag === 'false') {
    return { hostRouting: false, secret: null };
  }
  if (flag !== '1' && flag !== 'true') {
    throw new StorefrontRoutingConfigError(
      `${STOREFRONT_HOST_ROUTING_ENV} must be 1/true or 0/false.`,
    );
  }
  const secret = env[STOREFRONT_CONTEXT_SECRET_ENV] ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new StorefrontRoutingConfigError(
      `${STOREFRONT_HOST_ROUTING_ENV} is on but ${STOREFRONT_CONTEXT_SECRET_ENV} is missing or shorter than ${MIN_SECRET_LENGTH} characters.`,
    );
  }
  return { hostRouting: true, secret };
}

export function signStorefrontContext(
  secret: string,
  hostname: string,
  seconds: number,
): string {
  return createHmac('sha256', secret)
    .update(storefrontContextMessage(hostname, seconds))
    .digest('hex');
}

type HeaderBag = Record<string, string | string[] | undefined>;

function single(headers: HeaderBag, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

// The hostname carried by a valid signed storefront context, normalized, or
// null for anything else (missing, duplicated, malformed, stale, future,
// forged).
export function verifyStorefrontContext(input: {
  headers: HeaderBag;
  secret: string;
  nowSeconds: number;
}): string | null {
  const host = single(input.headers, STOREFRONT_HOST_HEADER);
  const timestamp = single(input.headers, STOREFRONT_HOST_TIMESTAMP_HEADER);
  const signature = single(input.headers, STOREFRONT_HOST_SIGNATURE_HEADER);
  if (host === null || timestamp === null || signature === null) return null;
  if (!/^\d{1,12}$/.test(timestamp)) return null;
  const seconds = Number(timestamp);
  if (
    Math.abs(input.nowSeconds - seconds) > STOREFRONT_CONTEXT_MAX_SKEW_SECONDS
  ) {
    return null;
  }
  // The web tier signs the normalized form; anything else is not ours.
  const hostname = normalizeStorefrontHost(host);
  if (hostname === null || hostname !== host) return null;
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const expected = Buffer.from(
    signStorefrontContext(input.secret, hostname, seconds),
    'hex',
  );
  const given = Buffer.from(signature, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  return hostname;
}
