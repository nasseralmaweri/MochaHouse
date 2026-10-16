import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PLATFORM_NO_MONTHLY_PRICE,
  PLATFORM_PRICE_NOT_ACTIVE,
  type PlatformBillingPolicy,
  type PlatformPlan,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import {
  PLAN_INCLUDE,
  toPlan,
} from '../../platform-subscriptions/application/subscription-plans.service';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import {
  annualAmountFromDiscount,
  type BillingPolicyInput,
  type PriceCreateInput,
} from '../domain/pricing';
import { DEFAULT_BILLING_POLICY_ID } from './billing-lifecycle.service';

// SC3a — the SaaS price list and billing policy (platform operators only;
// every change is audited in the same transaction). A new list price for an
// interval ARCHIVES the previous one in the same change; businesses keep the
// price they agreed to (TenantSubscription.planPriceId is never touched
// here). Nothing here charges anyone or talks to a billing provider.

type Tx = Prisma.TransactionClient;

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

const PLAN_NOT_FOUND = 'Plan not found.';

@Injectable()
export class BillingCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async createPrice(
    planId: string,
    input: PriceCreateInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    if (!isUuid(planId)) throw new NotFoundException(PLAN_NOT_FOUND);
    return runSerializable(this.prisma, async (tx) => {
      const plan = await tx.subscriptionPlan.findUnique({
        where: { id: planId },
        select: { id: true },
      });
      if (!plan) throw new NotFoundException(PLAN_NOT_FOUND);

      let amount: number;
      if ('amountMinorUnits' in input) {
        amount = input.amountMinorUnits;
      } else {
        const monthly = await tx.subscriptionPlanPrice.findFirst({
          where: {
            planId,
            interval: 'MONTH',
            currency: input.currency,
            status: 'ACTIVE',
          },
          select: { amountMinorUnits: true },
        });
        if (!monthly) {
          throw conflict(
            PLATFORM_NO_MONTHLY_PRICE,
            'Set a monthly price first: the annual discount is applied to twelve monthly payments.',
          );
        }
        amount = annualAmountFromDiscount(
          monthly.amountMinorUnits,
          input.annualDiscountBasisPoints,
        );
      }

      const now = new Date();
      await tx.subscriptionPlanPrice.updateMany({
        where: {
          planId,
          interval: input.interval,
          currency: input.currency,
          status: 'ACTIVE',
        },
        data: { status: 'ARCHIVED', archivedAt: now },
      });
      await tx.subscriptionPlanPrice.create({
        data: {
          planId,
          interval: input.interval,
          currency: input.currency,
          amountMinorUnits: amount,
          actorPlatformOperatorId: operator.id,
        },
      });
      await this.auditPlan(
        tx,
        PLATFORM_AUDIT_ACTIONS.planPriceCreated,
        operator,
        planId,
        requestReference,
      );
      return toPlan(await this.loadPlan(tx, planId));
    });
  }

  async archivePrice(
    planId: string,
    priceId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    if (!isUuid(planId) || !isUuid(priceId)) {
      throw new NotFoundException(PLAN_NOT_FOUND);
    }
    return runSerializable(this.prisma, async (tx) => {
      const price = await tx.subscriptionPlanPrice.findFirst({
        where: { id: priceId, planId },
        select: { status: true },
      });
      if (!price) throw new NotFoundException(PLAN_NOT_FOUND);
      if (price.status !== 'ACTIVE') {
        throw conflict(
          PLATFORM_PRICE_NOT_ACTIVE,
          'This price is already archived.',
        );
      }
      await tx.subscriptionPlanPrice.update({
        where: { id: priceId },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      await this.auditPlan(
        tx,
        PLATFORM_AUDIT_ACTIONS.planPriceArchived,
        operator,
        planId,
        requestReference,
      );
      return toPlan(await this.loadPlan(tx, planId));
    });
  }

  async getPolicy(): Promise<PlatformBillingPolicy> {
    return this.toPolicy(
      await this.prisma.billingPolicy.findUniqueOrThrow({
        where: { id: DEFAULT_BILLING_POLICY_ID },
      }),
    );
  }

  // Applies to trials and grace periods that START afterwards: running ones
  // keep the end date copied onto their subscription.
  async updatePolicy(
    input: BillingPolicyInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformBillingPolicy> {
    return runSerializable(this.prisma, async (tx) => {
      const policy = await tx.billingPolicy.update({
        where: { id: DEFAULT_BILLING_POLICY_ID },
        data: {
          trialDays: input.trialDays,
          trialRequiresPaymentMethod: input.trialRequiresPaymentMethod,
          gracePeriodDays: input.gracePeriodDays,
          actorPlatformOperatorId: operator.id,
        },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.billingPolicyUpdated,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          // The one platform-wide policy: the action names it (audit
          // targets are business or plan ids).
          requestReference: requestReference ?? null,
        },
      });
      return this.toPolicy(policy);
    });
  }

  private toPolicy(row: {
    trialDays: number;
    trialRequiresPaymentMethod: boolean;
    gracePeriodDays: number;
    updatedAt: Date;
  }): PlatformBillingPolicy {
    return {
      trialDays: row.trialDays,
      trialRequiresPaymentMethod: row.trialRequiresPaymentMethod,
      gracePeriodDays: row.gracePeriodDays,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async loadPlan(tx: Tx, planId: string) {
    return tx.subscriptionPlan.findUniqueOrThrow({
      where: { id: planId },
      include: PLAN_INCLUDE,
    });
  }

  private async auditPlan(
    tx: Tx,
    action: string,
    operator: PlatformOperatorRow,
    planId: string,
    requestReference: string | undefined,
  ): Promise<void> {
    await tx.platformAuditEvent.create({
      data: {
        action,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        targetType: 'plan',
        targetId: planId,
        requestReference: requestReference ?? null,
      },
    });
  }
}
