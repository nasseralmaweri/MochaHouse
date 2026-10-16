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
