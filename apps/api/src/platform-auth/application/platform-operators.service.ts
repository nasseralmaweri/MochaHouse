import { Injectable } from '@nestjs/common';
import type { PlatformMeResponse } from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  PlatformIdentity,
  PlatformOperatorRow,
} from '../infrastructure/platform-identity';

// SC1a — the platform-operator record behind a verified platform identity,
// and the platform audit trail.
//
// Resolution is by the VERIFIED (provider, subject) pair only — never by
// email, never by any tenant membership or role. There is no just-in-time
// creation: an identity with no PlatformOperator row is simply not an
// operator (rows come only from the provisioning CLI).

export type PlatformOperatorResolution =
  | { outcome: 'active'; operator: PlatformOperatorRow }
  | { outcome: 'disabled'; operator: PlatformOperatorRow }
  | { outcome: 'unknown' };

export const PLATFORM_AUDIT_ACTIONS = {
  accessDenied: 'platform.access.denied',
  sessionVerified: 'platform.session.verified',
} as const;

@Injectable()
export class PlatformOperatorsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    identity: PlatformIdentity,
  ): Promise<PlatformOperatorResolution> {
    const operator = await this.prisma.platformOperator.findUnique({
      where: {
        externalProvider_externalSubject: {
          externalProvider: identity.provider,
          externalSubject: identity.subject,
        },
      },
    });
    if (!operator) {
      return { outcome: 'unknown' };
    }
    return operator.status === 'ACTIVE'
      ? { outcome: 'active', operator }
      : { outcome: 'disabled', operator };
  }

  // A verified identity was refused. Only reachable with a token that
  // verified against the platform boundary, so it cannot be used to flood
  // the table anonymously. Identifiers only — never a token.
  async recordDenied(
    identity: PlatformIdentity,
    resolution: Exclude<PlatformOperatorResolution, { outcome: 'active' }>,
    requestReference: string | undefined,
  ): Promise<void> {
    await this.prisma.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.accessDenied,
        outcome: 'DENIED',
        reasonCode:
          resolution.outcome === 'disabled'
            ? 'OPERATOR_DISABLED'
            : 'UNKNOWN_OPERATOR',
        actorPlatformOperatorId:
          resolution.outcome === 'disabled' ? resolution.operator.id : null,
        identityProvider: identity.provider,
        identitySubject: identity.subject,
        requestReference: requestReference ?? null,
      },
    });
  }

  // GET /api/v1/platform/me — the operator's session check. Records the
  // privileged access and the observational last-authenticated time in ONE
  // transaction, then answers with the profile (no subject, no claims).
  async verifySession(
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformMeResponse> {
    await this.prisma.$transaction([
      this.prisma.platformOperator.update({
        where: { id: operator.id },
        data: { lastAuthenticatedAt: new Date() },
      }),
      this.prisma.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.sessionVerified,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          requestReference: requestReference ?? null,
        },
      }),
    ]);
    return {
      operator: {
        id: operator.id,
        email: operator.email,
        displayName: operator.displayName,
        status: 'ACTIVE',
      },
    };
  }
}
