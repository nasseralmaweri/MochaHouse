import { BadRequestException } from '@nestjs/common';
import {
  isOptionalModuleKey,
  type OwnerOnboardingPlanOption,
  type SubscriptionModuleKey,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';

// SC4b/SC4c — the ONE rule for what a business owner may choose themselves
// (owner decisions D3, B1, C3, C4), shared by business creation, the plan
// change before payment and payment setup:
//   - a plan an operator offers for self-service, never Founding;
//   - its NEWEST published version;
//   - an ACTIVE price of that plan;
//   - exactly the interval, currency and amount the owner saw.
// Retired or hidden plans and prices are never offered to a new buyer and
// never substituted: the owner chooses again.

type Db = Prisma.TransactionClient | PrismaService;

export interface ExpectedPrice {
  interval: 'MONTH' | 'YEAR';
  currency: string;
  amountMinorUnits: number;
}

export type SelfServiceChoice =
  | {
      kind: 'ok';
      planId: string;
      planVersionId: string;
      planPriceId: string;
    }
  | { kind: 'plan-unavailable' }
  | { kind: 'price-changed' };

export async function selfServicePlanOptions(
  db: Db,
): Promise<OwnerOnboardingPlanOption[]> {
  const plans = await db.subscriptionPlan.findMany({
    where: { selfServiceAvailable: true, key: { not: 'founding' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      versions: {
        where: { status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
        take: 1,
      },
      prices: {
        where: { status: 'ACTIVE' },
        orderBy: [{ interval: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });
  return plans
    .filter((plan) => plan.versions.length === 1 && plan.prices.length > 0)
    .map((plan) => {
      const version = plan.versions[0];
      const modules: SubscriptionModuleKey[] = [
        'core',
        ...version.moduleKeys.filter(isOptionalModuleKey),
      ];
      return {
        planId: plan.id,
        planVersionId: version.id,
        name: plan.name,
        description: plan.description,
        modules,
        prices: plan.prices.map((price) => ({
          planPriceId: price.id,
          interval: price.interval,
          currency: price.currency,
          amountMinorUnits: price.amountMinorUnits,
        })),
      };
    });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// The owner's choice as sent: the plan version, the price and the price as
// it was SHOWN (400 when malformed).
export function parseSelfServiceSelection(input: Record<string, unknown>): {
  planVersionId: string;
  planPriceId: string;
  expectedPrice: ExpectedPrice;
} {
  const expected = input.expectedPrice as Record<string, unknown> | undefined;
  if (
    typeof input.planVersionId !== 'string' ||
    !UUID_PATTERN.test(input.planVersionId) ||
    typeof input.planPriceId !== 'string' ||
    !UUID_PATTERN.test(input.planPriceId) ||
    typeof expected !== 'object' ||
    expected === null ||
    (expected.interval !== 'MONTH' && expected.interval !== 'YEAR') ||
    typeof expected.currency !== 'string' ||
    !CURRENCY_PATTERN.test(expected.currency) ||
    typeof expected.amountMinorUnits !== 'number' ||
    !Number.isInteger(expected.amountMinorUnits) ||
    expected.amountMinorUnits < 0
  ) {
    throw new BadRequestException('Choose a plan and a price.');
  }
  return {
    planVersionId: input.planVersionId,
    planPriceId: input.planPriceId,
    expectedPrice: {
      interval: expected.interval,
      currency: expected.currency,
      amountMinorUnits: expected.amountMinorUnits,
    },
  };
}

// Whether this plan version and price are offered for self-service NOW.
export async function selfServiceSelectionOffered(
  db: Db,
  planVersionId: string,
  planPriceId: string,
): Promise<{ planId: string } | null> {
  const version = await db.subscriptionPlanVersion.findUnique({
    where: { id: planVersionId },
    include: { plan: true },
  });
  if (
    !version ||
    version.status !== 'PUBLISHED' ||
    !version.plan.selfServiceAvailable ||
    version.plan.key === 'founding'
  ) {
    return null;
  }
  const newest = await db.subscriptionPlanVersion.findFirst({
    where: { planId: version.planId, status: 'PUBLISHED' },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  if (newest?.id !== version.id) return null;
  const price = await db.subscriptionPlanPrice.findUnique({
    where: { id: planPriceId },
    select: { planId: true, status: true },
  });
  if (!price || price.planId !== version.planId || price.status !== 'ACTIVE') {
    return null;
  }
  return { planId: version.planId };
}

// The owner's choice, checked against what is offered and what they saw.
export async function resolveSelfServiceChoice(
  db: Db,
  input: {
    planVersionId: string;
    planPriceId: string;
    expectedPrice: ExpectedPrice;
  },
): Promise<SelfServiceChoice> {
  const offered = await selfServiceSelectionOffered(
    db,
    input.planVersionId,
    input.planPriceId,
  );
  if (!offered) return { kind: 'plan-unavailable' };
  const price = await db.subscriptionPlanPrice.findUniqueOrThrow({
    where: { id: input.planPriceId },
  });
  if (
    price.interval !== input.expectedPrice.interval ||
    price.currency !== input.expectedPrice.currency ||
    price.amountMinorUnits !== input.expectedPrice.amountMinorUnits
  ) {
    return { kind: 'price-changed' };
  }
  return {
    kind: 'ok',
    planId: offered.planId,
    planVersionId: input.planVersionId,
    planPriceId: input.planPriceId,
  };
}
