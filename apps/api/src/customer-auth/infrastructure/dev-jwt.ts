import { createHmac, timingSafeEqual } from 'node:crypto';

// DEV-ONLY / TEST SEAM — not a production credential format. A minimal,
// self-contained HS256-signed JWT so local development and automated tests
// can exercise the full customer-auth boundary without live AWS Cognito
// (see auth-provider-mode.ts for how this stays fail-closed in
// production). Structurally a real JWT (base64url header.payload.signature)
// so it can be verified the same way a real Cognito token is: parse, check
// signature, check expiry, extract subject — deliberately not a bespoke
// shortcut format.

export interface DevJwtPayload {
  sub: string;
  email: string | null;
  name: string | null;
  exp: number;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function signDevJwt(
  claims: Omit<DevJwtPayload, 'exp'>,
  secret: string,
  ttlSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      ...claims,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyDevJwt(token: string, secret: string): DevJwtPayload {
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
  ) as DevJwtPayload;

  if (
    typeof parsed.exp !== 'number' ||
    parsed.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Token has expired.');
  }
  if (typeof parsed.sub !== 'string' || parsed.sub.length === 0) {
    throw new Error('Token is missing a subject.');
  }

  return parsed;
}
