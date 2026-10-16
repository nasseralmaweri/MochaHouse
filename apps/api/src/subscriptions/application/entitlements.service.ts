import { Injectable } from '@nestjs/common';
import {
  isOptionalModuleKey,
  type InternalEntitlementsSummary,
  type SubscriptionModuleKey,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { entitledToPlanModules } from '../../saas-billing/domain/billing-lifecycle';
import { billingEnforcementEnabled } from '../../saas-billing/application/billing-enforcement.config';

// SC2a — what a business's subscription entitles it to, computed in ONE
// place: core (always) + the modules of its subscribed plan version + its
// add-on grants. A business with NO subscription has core only — never
// "everything" (fail closed). Read-only.
//
// SC3c-1 — with billing enforcement on, a BILLED subscription that is not in
// good standing (an expired trial — including its recovery window — unpaid,
// or ended) loses its PLAN's modules: core and explicit operator add-on
// grants remain. Grace (PAST_DUE) keeps everything.
//
// Customer-facing surfaces (checkout, public forms, workers) are SC2b; this
// slice enforces entitlements on the business admin (staff) API.

export interface TenantEntitlements {
  modules: ReadonlySet<SubscriptionModuleKey>;
  planName: string | null;
  subscribed: boolean;
}

// Core plus every known optional key from the plan and the grants (unknown
// stored keys are ignored; the database CHECK already refuses them).
export function effectiveModules(
  planModuleKeys: readonly string[],
  grantedModuleKeys: readonly string[],
): Set<SubscriptionModuleKey> {
  const modules = new Set<SubscriptionModuleKey>(['core']);
  for (const key of [...planModuleKeys, ...grantedModuleKeys]) {
    if (isOptionalModuleKey(key)) modules.add(key);
  }
  return modules;
}

export function entitlementsSummary(
  entitlements: TenantEntitlements,
): InternalEntitlementsSummary {
  return {
    modules: [...entitlements.modules].sort((a, b) =>
      a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b),
    ),
    planName: entitlements.planName,
  };
}

export const CORE_ONLY: TenantEntitlements = {
  modules: new Set<SubscriptionModuleKey>(['core']),
  planName: null,
  subscribed: false,
};

@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async forTenant(
    tenantId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<TenantEntitlements> {
    const subscription = await db.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      select: {
        billingMode: true,
        status: true,
        graceExceptionEndsAt: true,
        planVersion: {
          select: {
            moduleKeys: true,
            plan: { select: { name: true, key: true } },
          },
        },
        moduleGrants: { select: { moduleKey: true } },
      },
    });
    if (!subscription) return CORE_ONLY;
    // Founding businesses (Mocha House, Tenant #1, among them) are exempt
    // from billing enforcement, as from billing suspension.
    const exempt = subscription.planVersion.plan.key === 'founding';
    const planModules =
      billingEnforcementEnabled() &&
      !exempt &&
      !entitledToPlanModules(subscription)
        ? []
        : subscription.planVersion.moduleKeys;
    return {
      modules: effectiveModules(
        planModules,
        subscription.moduleGrants.map((grant) => grant.moduleKey),
      ),
      planName: subscription.planVersion.plan.name,
      subscribed: true,
    };
  }
}
