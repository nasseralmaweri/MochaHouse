import { createHmac } from 'node:crypto';

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. The exact analogue of deriveDevVerificationCode
// for password recovery: Cognito generates and emails the real recovery
// code out-of-band, and there is no email infrastructure in this slice, so
// the dev boundary derives the "sent" code deterministically from the email
// and AUTH_DEV_JWT_SECRET — reproducible by both the provider and a test,
// never logged, stored, or returned in any response body. The 'recovery:'
// domain separator makes this code differ from the same email's
// verification code, so one can never be used in place of the other.
// Knowing it only lets you reset a password for an account you already
// control in a non-production environment — the same trust level the dev
// auth boundary assumes everywhere.
export function deriveDevRecoveryCode(email: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(`recovery:${email.trim().toLowerCase()}`)
    .digest();
  const numeric = digest.readUInt32BE(0) % 1000000;
  return numeric.toString().padStart(6, '0');
}
