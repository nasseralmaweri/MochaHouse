import { createHmac, timingSafeEqual } from 'node:crypto';

// DEV-ONLY / TEST SEAM — not a production credential format. A minimal
// HS256 JWT so local development and the automated tests can exercise the
// whole platform-operator boundary without a live platform Cognito pool
// (see platform-auth-provider-mode.ts for how this stays fail-closed in
// production).
//
// A SEPARATE codec from the customer and tenant-staff dev tokens. Three
// independent guarantees keep any other token out:
//   1. It is signed/verified with PLATFORM_AUTH_DEV_JWT_SECRET (the startup
//      guard requires it to differ from both other dev secrets).
//   2. Every platform dev token carries `marker: "platform-dev"`, and
//      verification rejects any token without it — the staff codec in turn
//      rejects this marker.
//   3. It must carry `mfa: true`. In production MFA is enforced by the
//      platform Cognito pool's configuration (MFA required); this claim is
//      the dev provider's stand-in for that, so the tests can prove an
//      identity that did not complete MFA is refused.
const PLATFORM_DEV_MARKER = 'platform-dev';

export interface PlatformDevJwtClaims {
  sub: string;
  // Whether the dev "sign-in" completed MFA. Must be exactly true.
  mfa: boolean;
}

interface PlatformDevJwtPayload extends PlatformDevJwtClaims {
  marker: typeof PLATFORM_DEV_MARKER;
  exp: number;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function signPlatformDevJwt(
  claims: PlatformDevJwtClaims,
  secret: string,
  ttlSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      ...claims,
      marker: PLATFORM_DEV_MARKER,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyPlatformDevJwt(
  token: string,
  secret: string,
): { sub: string } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed token.');
  }
  const [header, payload, signature] = parts;
  const expectedSignature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new Error('Invalid token signature.');
  }
  let parsed: PlatformDevJwtPayload;
  try {
    parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as PlatformDevJwtPayload;
  } catch {
    throw new Error('Malformed token.');
  }
  if (parsed.marker !== PLATFORM_DEV_MARKER) {
    throw new Error('Not a platform token.');
  }
  if (
    typeof parsed.exp !== 'number' ||
    parsed.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Token has expired.');
  }
  if (typeof parsed.sub !== 'string' || parsed.sub.length === 0) {
    throw new Error('Token is missing a subject.');
  }
  if (parsed.mfa !== true) {
    throw new Error('Multi-factor authentication was not completed.');
  }
  return { sub: parsed.sub };
}
