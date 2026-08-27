import { createHmac, timingSafeEqual } from 'node:crypto';

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. In production Cognito stores the password and
// verifies it; the dev boundary has no user store, so it keeps a
// non-reversible HMAC of the password (keyed by the same AUTH_DEV_JWT_SECRET
// the rest of the dev boundary already requires) purely so a dev/test
// sign-in can tell the current password from an old one after a reset. This
// is not a production password hash (no per-user salt, no work factor) and
// is never appropriate outside the dev seam. The plaintext password is
// never stored and never logged.
export function deriveDevPasswordHash(
  password: string,
  secret: string,
): string {
  return createHmac('sha256', secret).update(password).digest('hex');
}

export function devPasswordMatches(
  password: string,
  expectedHash: string,
  secret: string,
): boolean {
  const provided = Buffer.from(deriveDevPasswordHash(password, secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
