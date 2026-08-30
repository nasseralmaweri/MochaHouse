import type { Request } from 'express';
import type { Prisma } from '@mocha-house/database';
// Type-only import (erased at compile time) — no runtime dependency from
// the infrastructure layer on the authorization layer.
import type { AuthorizationContext } from '../authorization/authorization-context';

// The plain InternalUser row shape, mirroring how the customer domain types
// its own rows (see customers.service.ts).
export type InternalUserRow = Prisma.InternalUserGetPayload<
  Record<string, never>
>;

// What the internal-auth boundary proves about an incoming request once an
// internal token has been successfully verified — deliberately a few plain
// strings, never a Cognito SDK payload/claims object. This is a SEPARATE
// type from the customer boundary's CustomerIdentity and must never be used
// in its place: nothing here ever grants customer access, and a
// CustomerIdentity never grants internal access.
export interface InternalIdentity {
  // The internal provider marker — 'cognito-internal' in production,
  // 'internal-dev' for the local/test provider. Distinct from the customer
  // markers ('cognito' / 'dev') so the two identity spaces can never
  // collide even if a helper is shared.
  provider: string;
  subject: string;
  email: string | null;
  name: string | null;
}

// Attached to the request by InternalAuthGuard, and only ever by it:
//   - internalIdentity: what the verified token asserted.
//   - internalUser: the resolved, ACTIVE Mocha House InternalUser. Its
//     presence is the proof that lifecycle enforcement has run — a valid
//     token alone never sets it.
// Deliberately NOT `customerIdentity` — the internal boundary never writes
// to, or reads from, the customer request contract.
export interface InternalAuthenticatedRequest extends Request {
  internalIdentity?: InternalIdentity;
  internalUser?: InternalUserRow;
  // Set by PermissionGuard (Milestone 5B), never by InternalAuthGuard. Its
  // presence means the route's required permission has been checked and the
  // effective grants are available to the service layer for
  // resource/location-specific authorization.
  authorization?: AuthorizationContext;
}
