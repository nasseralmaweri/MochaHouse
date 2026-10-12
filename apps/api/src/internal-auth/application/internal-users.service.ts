import { Injectable } from '@nestjs/common';
import type { InternalUserProfile } from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  InternalIdentity,
  InternalUserRow,
} from '../infrastructure/internal-identity';

// The outcome of mapping a verified internal identity to a Mocha House
// InternalUser. Only 'active' permits internal/Admin access; the guard
// collapses every other outcome to one generic 403 so the response never
// reveals which lifecycle state (or non-existence) was the reason.
export type InternalUserResolution =
  | { outcome: 'active'; user: InternalUserRow }
  | { outcome: 'not-found' }
  | { outcome: 'inactive'; status: InternalUserRow['status'] };

@Injectable()
export class InternalUsersService {
  constructor(private readonly prisma: PrismaService) {}

  // Resolves the authenticated external identity to an EXISTING InternalUser
  // and enforces the lifecycle gate. Deliberately never creates a record:
  // an internal user must have been provisioned (INVITED, then activated)
  // out of band. Deliberately never activates: a valid token proves
  // identity only — moving INVITED -> ACTIVE is an administrative action
  // (Milestone 5B), never a side effect of signing in.
  //
  // Resolution key (both inside `tenantId` only):
  //   1. (tenantId, externalProvider, externalSubject) — the authoritative
  //      identity mapping once the subject is known. Unique PER TENANT since
  //      Milestone S0F: the same verified human may hold one row in each
  //      business they belong to, and this picks the row for THIS tenant.
  //   2. Fallback: (externalProvider, email, tenantId) for a row whose
  //      externalSubject is still null — i.e. a user provisioned by email
  //      who has not authenticated before. The subject is bound only once
  //      the row is confirmed ACTIVE (below), so a non-ACTIVE user is never
  //      mutated by an authentication attempt.
  //
  // Milestone S0D-2E / S0F — `tenantId` is the request's trusted active
  // business, chosen by InternalAuthGuard only after membership validation
  // (InternalTenantMembershipService). Whichever path finds a candidate, it
  // must belong to THIS
  // tenant or resolution fails exactly like "no such internal user" (the
  // same generic outcome InternalAuthGuard turns into one 403 — this can
  // never distinguish "wrong tenant" from "unknown identity" in the
  // response). This is what makes InternalUser.email's new (tenantId,
  // email) uniqueness safe: two tenants' same-email, not-yet-bound users
  // can never resolve to each other's row.
  async resolveForAuthentication(
    identity: InternalIdentity,
    tenantId: string,
  ): Promise<InternalUserResolution> {
    const bySubject = identity.subject
      ? await this.prisma.internalUser.findUnique({
          where: {
            tenantId_externalProvider_externalSubject: {
              tenantId,
              externalProvider: identity.provider,
              externalSubject: identity.subject,
            },
          },
        })
      : null;

    const candidate =
      bySubject ?? (await this.findUnboundByEmail(identity, tenantId));

    if (!candidate || candidate.tenantId !== tenantId) {
      return { outcome: 'not-found' };
    }

    if (candidate.status !== 'ACTIVE') {
      // No write at all for INVITED / SUSPENDED / DISABLED — an
      // authentication attempt by a non-ACTIVE user leaves the record
      // exactly as it was.
      return { outcome: 'inactive', status: candidate.status };
    }

    const user = await this.recordSuccessfulAuthentication(candidate, identity);
    if (!user) {
      return { outcome: 'not-found' };
    }
    return { outcome: 'active', user };
  }

  toProfile(user: InternalUserRow): InternalUserProfile {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
    };
  }

  private async findUnboundByEmail(
    identity: InternalIdentity,
    tenantId: string,
  ): Promise<InternalUserRow | null> {
    // Security 4A — binding a login to an unbound row by email requires
    // the identity provider to have verified that email. An unverified or
    // absent claim never binds (the caller then reports "not-found").
    if (!identity.email || identity.emailVerified !== true) {
      return null;
    }
    return this.prisma.internalUser.findFirst({
      where: {
        externalProvider: identity.provider,
        email: identity.email,
        externalSubject: null,
        tenantId,
      },
    });
  }

  // Observational bookkeeping only, applied strictly AFTER the ACTIVE check.
  // Binds the external subject on first authentication of an
  // email-provisioned user, and stamps lastAuthenticatedAt. Neither can
  // widen access — status is never touched here.
  private async recordSuccessfulAuthentication(
    user: InternalUserRow,
    identity: InternalIdentity,
  ): Promise<InternalUserRow | null> {
    const shouldBindSubject =
      !!identity.subject && user.externalSubject !== identity.subject;

    // Security 4A — binding is compare-and-set: it only succeeds while the
    // row is still unbound, so two logins racing for the same invitation
    // can never overwrite one another's binding. The loser is "not-found".
    if (shouldBindSubject) {
      const bound = await this.prisma.internalUser.updateMany({
        where: { id: user.id, externalSubject: null },
        data: {
          lastAuthenticatedAt: new Date(),
          externalSubject: identity.subject,
        },
      });
      return bound.count === 1
        ? this.prisma.internalUser.findUniqueOrThrow({ where: { id: user.id } })
        : null;
    }

    return this.prisma.internalUser.update({
      where: { id: user.id },
      data: { lastAuthenticatedAt: new Date() },
    });
  }
}
