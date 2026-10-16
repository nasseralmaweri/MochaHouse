import type { Request } from 'express';
import type { Prisma } from '@mocha-house/database';

export type PlatformOperatorRow = Prisma.PlatformOperatorGetPayload<
  Record<string, never>
>;

// The two platform identity providers. Distinct from every customer
// ('cognito' / 'dev') and tenant-staff ('cognito-internal' / 'internal-dev')
// marker, so the identity spaces can never collide.
export const PLATFORM_COGNITO_PROVIDER = 'cognito-platform';
export const PLATFORM_DEV_PROVIDER = 'platform-dev';

// What the platform boundary proves about a request once a platform token
// has verified: a few plain strings, never a claims object. A SEPARATE type
// from CustomerIdentity and InternalIdentity — neither can stand in for it.
export interface PlatformIdentity {
  provider: typeof PLATFORM_COGNITO_PROVIDER | typeof PLATFORM_DEV_PROVIDER;
  subject: string;
  // SC1e — when the operator signed in (with MFA) for this token, in epoch
  // seconds: Cognito's auth_time (else iat; the platform issues no refresh
  // tokens, so an ID token is always minted at sign-in). null when the token
  // does not say — a recent-sign-in check then fails closed.
  authenticatedAt: number | null;
}

// Attached by PlatformAuthGuard, and only by it. `platformOperator` is the
// re-read, ACTIVE PlatformOperator row — its presence is the proof that the
// lifecycle check ran on THIS request. A platform request never carries a
// tenantContext, customerIdentity or internalUser.
export interface PlatformAuthenticatedRequest extends Request {
  requestId?: string;
  platformIdentity?: PlatformIdentity;
  platformOperator?: PlatformOperatorRow;
}
