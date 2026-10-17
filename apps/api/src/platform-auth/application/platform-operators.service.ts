import { Injectable } from '@nestjs/common';
import {
  PLATFORM_PERMISSIONS,
  type PlatformMeResponse,
  type PlatformPermission,
} from '@mocha-house/contracts';
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
  billingEnforcementSwept: 'platform.billing.enforcement_swept',
  // SC3c-3 — a grace extension / exception and a billing contact assignment
  // (target: the tenant).
  billingGraceExtended: 'platform.billing.grace_extended',
  billingContactAssigned: 'platform.billing.contact_assigned',
  // SC3d-1 — an operator previewed a plan change for a business (target:
  // the tenant; nothing charged or changed).
  billingPlanChangePreviewed: 'platform.billing.plan_change_previewed',
  // SC3e-2 — complimentary grants (target: the tenant) and review-case
  // actions (target: the case).
  billingComplimentaryGranted: 'platform.billing.complimentary_granted',
  billingComplimentaryWithdrawn: 'platform.billing.complimentary_withdrawn',
  billingComplimentaryStarted: 'platform.billing.complimentary_started',
  // SC3e-3 — console permission grants (target: the operator) and refunds
  // / credits (target: the tenant).
  operatorPermissionGranted: 'platform.operator.permission_granted',
  operatorPermissionRevoked: 'platform.operator.permission_revoked',
  billingAdjustmentRequested: 'platform.billing.adjustment_requested',
  billingAdjustmentDecided: 'platform.billing.adjustment_decided',
  billingAdjustmentCanceled: 'platform.billing.adjustment_canceled',
  billingAdjustmentExecuted: 'platform.billing.adjustment_executed',
  billingAdjustmentSettled: 'platform.billing.adjustment_settled',
  billingAdjustmentExternalRecorded:
    'platform.billing.adjustment_external_recorded',
  // SC3f — CENTERIVO-wide revenue report read (billing.reports.view).
  billingRevenueReportViewed: 'platform.billing.revenue_report_viewed',
  billingComplimentaryEnded: 'platform.billing.complimentary_ended',
  billingCaseRechecked: 'platform.billing.case_rechecked',
  billingScheduleReleased: 'platform.billing.schedule_released',
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
  async profile(operator: PlatformOperatorRow): Promise<PlatformMeResponse> {
    // SC3e-2 — the live grants (the API re-checks them on every action).
    const grants = await this.prisma.platformOperatorPermission.findMany({
      where: { operatorId: operator.id, revokedAt: null },
      orderBy: { permission: 'asc' },
      select: { permission: true },
    });
    return {
      operator: {
        id: operator.id,
        email: operator.email,
        displayName: operator.displayName,
        status: 'ACTIVE',
      },
      permissions: grants
        .map((grant) => grant.permission)
        .filter((permission): permission is PlatformPermission =>
          (PLATFORM_PERMISSIONS as readonly string[]).includes(permission),
        ),
    };
  }
}
