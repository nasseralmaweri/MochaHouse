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
  // SC1b — audited once per sign-in (after MFA) and per sign-out, not per
  // page view.
  sessionEstablished: 'platform.session.established',
  sessionEnded: 'platform.session.ended',
  // SC1d — a business created by a platform operator (target: the tenant).
  tenantProvisioned: 'platform.tenant.provisioned',
  // SC1e — business lifecycle changes (target: the tenant).
  tenantSuspended: 'platform.tenant.suspended',
  tenantReactivated: 'platform.tenant.reactivated',
  tenantOwnerEmailCorrected: 'platform.tenant.owner_email_corrected',
  // SC2a — plans (target: the plan) and subscriptions (target: the tenant).
  planCreated: 'platform.plan.created',
  planVersionCreated: 'platform.plan.version_created',
  planVersionUpdated: 'platform.plan.version_updated',
  planVersionPublished: 'platform.plan.version_published',
  planVersionRetired: 'platform.plan.version_retired',
  tenantSubscriptionChanged: 'platform.tenant.subscription_changed',
  tenantAddonGranted: 'platform.tenant.addon_granted',
  tenantAddonRevoked: 'platform.tenant.addon_revoked',
  // SC3a — list prices (target: the plan) and the platform-wide billing
  // policy (no target: there is one).
  planPriceCreated: 'platform.plan.price_created',
  planPriceArchived: 'platform.plan.price_archived',
  billingPolicyUpdated: 'platform.billing.policy_updated',
  // SC3b — starting a business's billing (target: the tenant), running the
  // review-only reconciliation and resolving a case (no target).
  tenantBillingStarted: 'platform.tenant.billing_started',
  billingReconciled: 'platform.billing.reconciled',
  billingCaseResolved: 'platform.billing.case_resolved',
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

  // SC1b — the operator ended their session (sign-out).
  async recordSessionEnded(
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<void> {
    await this.prisma.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.sessionEnded,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        requestReference: requestReference ?? null,
      },
    });
  }

  // GET /api/v1/platform/me — the operator's profile (no subject, no
  // claims). SC1b: READ-ONLY. The portal calls it on every page, so it
  // writes nothing; the privileged access is audited once per sign-in
  // (platform.session.established) instead, when lastAuthenticatedAt is set.
  profile(operator: PlatformOperatorRow): PlatformMeResponse {
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
