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
import { isSelfServiceSetupPending } from '../../saas-billing/application/self-service-setup';

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
//
// SC4b — a business its OWNER created (self-service) whose billing the
// provider has never authorized (payment setup pending, owner decision B1)
// has core only — neither its plan's modules NOR operator add-on grants
// (owner decision, PR #66) — and may not take customer sales, whether
// billing enforcement is on or off. The grants are kept (never deleted) and
// apply again, with the plan's modules, once the provider has authorized
// billing or a trial. It never looks complimentary: it is BILLED at the
// price the owner chose. Businesses created or billed by an operator,
// complimentary and Founding businesses keep the existing rules unchanged.

export interface TenantEntitlements {
  modules: ReadonlySet<SubscriptionModuleKey>;
  planName: string | null;
  subscribed: boolean;
  // SC4b — false only while a self-service business awaits payment setup.
  salesEnabled: boolean;
  paymentSetupPending: boolean;
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
    paymentSetupPending: entitlements.paymentSetupPending,
  };
}

export const CORE_ONLY: TenantEntitlements = {
  modules: new Set<SubscriptionModuleKey>(['core']),
  planName: null,
  subscribed: false,
  salesEnabled: true,
  paymentSetupPending: false,
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
        trialStartedAt: true,
        currentPeriodStart: true,
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
    // SC4b — read only for a never-authorized BILLED subscription (rare).
    const paymentSetupPending = await isSelfServiceSetupPending(
      db,
      tenantId,
      subscription,
    );
    // Founding businesses (Mocha House, Tenant #1, among them) are exempt
    // from billing enforcement, as from billing suspension.
    const exempt = subscription.planVersion.plan.key === 'founding';
    const planModules =
      paymentSetupPending ||
      (billingEnforcementEnabled() &&
        !exempt &&
        !entitledToPlanModules(subscription))
        ? []
        : subscription.planVersion.moduleKeys;
    return {
      modules: effectiveModules(
        planModules,
        // SC4b — add-ons too are withheld (not removed) while pending.
        paymentSetupPending
          ? []
          : subscription.moduleGrants.map((grant) => grant.moduleKey),
      ),
      planName: subscription.planVersion.plan.name,
      subscribed: true,
      salesEnabled: !paymentSetupPending,
      paymentSetupPending,
    };
  }
}
