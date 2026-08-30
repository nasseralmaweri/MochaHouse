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
  // Resolution key:
  //   1. (externalProvider, externalSubject) — the authoritative identity
  //      mapping once the subject is known.
  //   2. Fallback: (externalProvider, email) for a row whose externalSubject
  //      is still null — i.e. a user provisioned by email who has not
  //      authenticated before. The subject is bound only once the row is
  //      confirmed ACTIVE (below), so a non-ACTIVE user is never mutated by
  //      an authentication attempt.
  async resolveForAuthentication(
    identity: InternalIdentity,
  ): Promise<InternalUserResolution> {
    const bySubject = identity.subject
      ? await this.prisma.internalUser.findUnique({
          where: {
            externalProvider_externalSubject: {
              externalProvider: identity.provider,
              externalSubject: identity.subject,
            },
          },
        })
      : null;

    const candidate = bySubject ?? (await this.findUnboundByEmail(identity));

    if (!candidate) {
      return { outcome: 'not-found' };
    }

    if (candidate.status !== 'ACTIVE') {
      // No write at all for INVITED / SUSPENDED / DISABLED — an
      // authentication attempt by a non-ACTIVE user leaves the record
      // exactly as it was.
      return { outcome: 'inactive', status: candidate.status };
    }

    const user = await this.recordSuccessfulAuthentication(candidate, identity);
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
  ): Promise<InternalUserRow | null> {
    if (!identity.email) {
      return null;
    }
    return this.prisma.internalUser.findFirst({
      where: {
        externalProvider: identity.provider,
        email: identity.email,
        externalSubject: null,
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
  ): Promise<InternalUserRow> {
    const shouldBindSubject =
      !!identity.subject && user.externalSubject !== identity.subject;

    return this.prisma.internalUser.update({
      where: { id: user.id },
      data: {
        lastAuthenticatedAt: new Date(),
        ...(shouldBindSubject ? { externalSubject: identity.subject } : {}),
      },
    });
  }
}
