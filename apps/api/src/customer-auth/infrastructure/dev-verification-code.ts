import { createHmac } from 'node:crypto';

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. A real verification code is generated and
// delivered by Cognito out-of-band (email); there is no email
// infrastructure in this slice to stand in for that in development, so
// this derives the "sent" code deterministically from the email and the
// same AUTH_DEV_JWT_SECRET the rest of the dev boundary already requires
// — reproducible by both this provider and a test, and never logged,
// stored, or returned in any response body. This is not a credential:
// knowing it only lets you confirm a registration you already control in
// a non-production environment, the same trust level the dev auth
// boundary already assumes everywhere else.
export function deriveDevVerificationCode(
  email: string,
  secret: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(email.trim().toLowerCase())
    .digest();
  const numeric = digest.readUInt32BE(0) % 1000000;
  return numeric.toString().padStart(6, '0');
}
