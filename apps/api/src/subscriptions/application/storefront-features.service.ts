import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FEATURE_NOT_AVAILABLE,
  SALES_NOT_AVAILABLE,
  STOREFRONT_FEATURE_KEYS,
  type FeatureNotAvailableError,
  type StorefrontFeatureKey,
  type StorefrontFeaturesResponse,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';

// SC2b — customer-facing entitlement enforcement. The ONE place a public
// route, checkout or a customer read learns which optional modules its
// business may offer. The tenant id always comes from the request's
// server-resolved TenantContext (or a row already owned by it) — never from
// anything the client sent — so one business's plan can never affect
// another's customers.
//
// A business with no subscription has core only (EntitlementsService fails
// closed), so every optional storefront feature is off.

export type StorefrontFeatures = Readonly<
  Record<StorefrontFeatureKey, boolean>
>;

const MESSAGES: Record<StorefrontFeatureKey, string> = {
  loyalty: 'Rewards are not available here right now.',
  promotions: 'Promotions and coupons are not available here right now.',
  giftcards: 'Gift-card purchases are not available here right now.',
  careers: 'Job applications are not available here right now.',
  franchising: 'Franchise inquiries are not available here right now.',
  cms: 'This page is not available.',
};

export function featureNotAvailable(
  feature: StorefrontFeatureKey,
): ForbiddenException {
  const body: FeatureNotAvailableError = {
    statusCode: 403,
    error: 'Forbidden',
    code: FEATURE_NOT_AVAILABLE,
    feature,
    message: MESSAGES[feature],
  };
  return new ForbiddenException(body);
}

// SC4b — 403 SALES_NOT_AVAILABLE: the business may not take orders yet.
export function salesNotAvailable(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: SALES_NOT_AVAILABLE,
    message: 'This business is not taking orders yet.',
  });
}

@Injectable()
export class StorefrontFeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // A point-in-time decision. Checkout evaluates this ONCE, before any
  // payment attempt exists, and carries the result through the order
  // transaction (it is never re-evaluated after payment).
  async forTenant(
    tenantId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<StorefrontFeatures> {
    return (await this.forCheckout(tenantId, db)).features;
  }

  // SC4b — the features AND whether the business may take customer orders
  // at all (false only while a self-service business awaits payment setup),
  // from one entitlement read. Checkout refuses before any payment attempt.
  async forCheckout(
    tenantId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ features: StorefrontFeatures; salesOpen: boolean }> {
    const { modules, salesEnabled } = await this.entitlements.forTenant(
      tenantId,
      db,
    );
    return {
      features: Object.freeze(
        Object.fromEntries(
          STOREFRONT_FEATURE_KEYS.map((key) => [key, modules.has(key)]),
        ) as Record<StorefrontFeatureKey, boolean>,
      ),
      salesOpen: salesEnabled,
    };
  }

  async isAvailable(
    tenantId: string,
    feature: StorefrontFeatureKey,
  ): Promise<boolean> {
    return (await this.forTenant(tenantId))[feature];
  }

  // SC4b — a SALE of a module's product (e.g. a gift card): the module AND
  // the business taking sales (never while payment setup is pending).
  async assertAvailableForSale(
    tenantId: string,
    feature: StorefrontFeatureKey,
  ): Promise<void> {
    const { features, salesOpen } = await this.forCheckout(tenantId);
    if (!salesOpen) throw salesNotAvailable();
    if (!features[feature]) throw featureNotAvailable(feature);
  }

  // 403 FEATURE_NOT_AVAILABLE — a customer action the plan does not include.
  async assertAvailable(
    tenantId: string,
    feature: StorefrontFeatureKey,
  ): Promise<void> {
    if (!(await this.isAvailable(tenantId, feature))) {
      throw featureNotAvailable(feature);
    }
  }

  // 404 — a page that only exists for a module the plan does not include
  // (indistinguishable from a page that does not exist).
  async assertPageAvailable(
    tenantId: string,
    feature: StorefrontFeatureKey,
  ): Promise<void> {
    if (!(await this.isAvailable(tenantId, feature))) {
      throw new NotFoundException('Page not found.');
    }
  }

  async response(tenantId: string): Promise<StorefrontFeaturesResponse> {
    return { features: { ...(await this.forTenant(tenantId)) } };
  }
}
