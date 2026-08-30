import { createHmac, timingSafeEqual } from 'node:crypto';

// DEV-ONLY / TEST SEAM — not a production credential format. A minimal,
// self-contained HS256-signed JWT so local development and automated tests
// can exercise the full internal-auth boundary without a live internal
// Cognito user pool (see internal-auth-provider-mode.ts for how this stays
// fail-closed in production).
//
// This is a SEPARATE codec from the customer boundary's dev-jwt on purpose.
// Two independent guarantees keep a customer dev token from ever verifying
// here:
//   1. It is signed/verified with INTERNAL_AUTH_DEV_JWT_SECRET, which is a
//      different secret from the customer AUTH_DEV_JWT_SECRET.
//   2. Every internal dev token carries `marker: "internal-dev"` and
//      verification rejects any token without it — so even a
//      misconfiguration that made the two secrets equal would not let a
//      customer token through.

const INTERNAL_DEV_MARKER = 'internal-dev';

export interface InternalDevJwtClaims {
  sub: string;
  email: string | null;
  name: string | null;
}

interface InternalDevJwtPayload extends InternalDevJwtClaims {
  marker: typeof INTERNAL_DEV_MARKER;
  exp: number;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function signInternalDevJwt(
  claims: InternalDevJwtClaims,
  secret: string,
  ttlSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      ...claims,
      marker: INTERNAL_DEV_MARKER,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyInternalDevJwt(
  token: string,
  secret: string,
): InternalDevJwtClaims {
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

  const parsed = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as InternalDevJwtPayload;

  // The internal marker is mandatory: a token that verifies by signature
  // but is not one this codec minted (e.g. a customer dev token, were the
  // secrets ever misconfigured to match) is rejected here.
  if (parsed.marker !== INTERNAL_DEV_MARKER) {
    throw new Error('Not an internal token.');
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

  return {
    sub: parsed.sub,
    email: typeof parsed.email === 'string' ? parsed.email : null,
    name: typeof parsed.name === 'string' ? parsed.name : null,
  };
}
