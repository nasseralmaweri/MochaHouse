import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  ONBOARDING_NOT_ELIGIBLE,
  ONBOARDING_PLAN_UNAVAILABLE,
  ONBOARDING_PRICE_CHANGED,
  isOptionalModuleKey,
  type OwnerBusinessCreateResponse,
  type OwnerOnboardingPlanOption,
  type OwnerOnboardingStatus,
  type SubscriptionModuleKey,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import type { InternalIdentity } from '../../internal-auth/infrastructure/internal-identity';
import {
  TenantProvisionRequestError,
  parseBusinessName,
} from '../../platform-tenants/application/tenant-provision-request';
import { TenantProvisioningService } from '../../platform-tenants/application/tenant-provisioning.service';

// SC4b — a verified, self-registered owner creates their ONE business
// (owner decisions B1–B4). Only the owner's own verified login counts: the
// registration is found by that login's (provider, subject) — never by an
// email, a request field or a header — and must be VERIFIED. Operator-
// created staff logins have no registration and are never eligible (B4).
// Nothing here grants access to a business: the business's own staff row,
// created bound to this login, is what later admits the owner through
// InternalAuthGuard, subject to the payment-setup-pending restrictions.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function notEligible(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: ONBOARDING_NOT_ELIGIBLE,
    message: 'This account cannot create a business here.',
  });
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

export interface ParsedBusinessCreate {
  businessName: string;
  planVersionId: string;
  planPriceId: string;
  expectedPrice: {
    interval: 'MONTH' | 'YEAR';
    currency: string;
    amountMinorUnits: number;
  };
}

export function parseBusinessCreate(raw: unknown): ParsedBusinessCreate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException('A JSON body is required.');
  }
  const input = raw as Record<string, unknown>;
  let businessName: string;
  try {
    businessName = parseBusinessName(input.businessName);
  } catch (error) {
    if (error instanceof TenantProvisionRequestError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
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
    businessName,
    planVersionId: input.planVersionId,
    planPriceId: input.planPriceId,
    expectedPrice: {
      interval: expected.interval,
      currency: expected.currency,
      amountMinorUnits: expected.amountMinorUnits,
    },
  };
}

@Injectable()
export class OwnerOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  // The VERIFIED registration of exactly this login, or 403.
  private async registrationOf(identity: InternalIdentity) {
    const registration = await this.prisma.ownerRegistration.findUnique({
      where: {
        identityProvider_identitySubject: {
          identityProvider: identity.provider,
          identitySubject: identity.subject,
        },
      },
    });
    if (
      !registration ||
      registration.status !== 'VERIFIED' ||
      registration.displayName === null
    ) {
      throw notEligible();
    }
    return registration;
  }

  async status(identity: InternalIdentity): Promise<OwnerOnboardingStatus> {
    const registration = await this.registrationOf(identity);
    if (registration.provisionedTenantId !== null) {
      const tenant = await this.prisma.tenant.findUniqueOrThrow({
        where: { id: registration.provisionedTenantId },
        select: { id: true, name: true },
      });
      return { status: 'BUSINESS_CREATED', business: tenant };
    }
    return {
      status: 'BUSINESS_REQUIRED',
      ownerName: registration.displayName!,
      email: registration.email,
      plans: await this.planOptions(),
    };
  }

  // Plans offered for self-service (never Founding): each one's newest
  // PUBLISHED version and its ACTIVE prices. A plan with no price is not
  // offered.
  async planOptions(): Promise<OwnerOnboardingPlanOption[]> {
    const plans = await this.prisma.subscriptionPlan.findMany({
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

  async createBusiness(
    identity: InternalIdentity,
    input: ParsedBusinessCreate,
    requestReference: string | undefined,
  ): Promise<OwnerBusinessCreateResponse> {
    const registration = await this.registrationOf(identity);
    const outcome = await this.provisioning.provisionForOwner(
      {
        registrationId: registration.id,
        identityProvider: identity.provider,
        identitySubject: identity.subject,
        ...input,
      },
      requestReference,
    );
    switch (outcome.kind) {
      case 'not-eligible':
        throw notEligible();
      case 'plan-unavailable':
        throw conflict(
          ONBOARDING_PLAN_UNAVAILABLE,
          'That plan or price is no longer offered. Choose again.',
        );
      case 'price-changed':
        throw conflict(
          ONBOARDING_PRICE_CHANGED,
          'That price has changed. Review the plans and choose again.',
        );
      default:
        return {
          business: outcome.business,
          replayed: outcome.kind === 'replayed',
        };
    }
  }
}
