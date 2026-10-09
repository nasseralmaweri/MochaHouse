import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminCustomerDetail,
  AdminCustomerListResponse,
  AdminCustomerSummary,
} from '@mocha-house/contracts';
import { Prisma, type TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { LoyaltyService } from '../../loyalty/application/loyalty.service';
import { LoyaltyRewardsService } from '../../loyalty/application/loyalty-rewards.service';
import { CustomerOrdersService } from '../../orders/application/customer-orders.service';
import { CustomerPreferredLocationsService } from '../../customers/application/customer-preferred-locations.service';
import { CustomerPreferencesService } from '../../customers/application/customer-preferences.service';
import { GiftCardCustomerSummaryService } from '../../gift-cards/application/gift-card-customer-summary.service';
import { CustomerNotesService } from './customer-notes.service';
import { toCustomerActivityItem } from './crm-activity';

type CustomerRow = Prisma.CustomerGetPayload<Record<string, never>>;

const LIST_PAGE_SIZE = 25;
const RECENT_ORDERS_LIMIT = 5;
const ACTIVITY_LIMIT = 30;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Milestone 8A — the HQ CRM read surface OVER the authoritative customer
// data. It owns no business data (only CustomerNote, via CustomerNotesService)
// and never writes to another domain's tables: every section of the detail
// is a projection returned by that domain's own read service. `customers.view`
// is the authorisation for the whole surface (CORPORATE-only in the catalog;
// PermissionGuard rejects a LOCATION grant and this service also asserts it).
@Injectable()
export class CrmCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loyalty: LoyaltyService,
    private readonly rewards: LoyaltyRewardsService,
    private readonly orders: CustomerOrdersService,
    private readonly preferredLocations: CustomerPreferredLocationsService,
    private readonly preferences: CustomerPreferencesService,
    private readonly giftCards: GiftCardCustomerSummaryService,
    private readonly notes: CustomerNotesService,
  ) {}

  async list(
    query: { q?: string; cursor?: string },
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminCustomerListResponse> {
    authorization.assertCorporate('customers.view');

    const q = typeof query.q === 'string' ? query.q.trim() : '';
    // The directory is the active business's customers only — never a
    // cross-tenant search, whatever `q` or `cursor` says.
    const where: Prisma.CustomerWhereInput = { tenantId: tenant.tenantId };

    if (q.length > 0) {
      where.OR = UUID_PATTERN.test(q)
        ? [
            { id: q },
            { email: { contains: q, mode: 'insensitive' } },
            { displayName: { contains: q, mode: 'insensitive' } },
          ]
        : [
            { email: { contains: q, mode: 'insensitive' } },
            { displayName: { contains: q, mode: 'insensitive' } },
          ];
    }

    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      // Customer.id is a uuid7 (timestamp-prefixed), so `id` descending is
      // monotonic with `createdAt` descending — a plain keyset on id.
      where.id = { ...(where.id as object | undefined), lt: query.cursor };
    }

    const rows = await this.prisma.customer.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_PAGE_SIZE + 1,
    });

    const hasMore = rows.length > LIST_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;

    return {
      customers: page.map((row) => this.toSummary(row)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async getDetail(
    customerId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminCustomerDetail> {
    authorization.assertCorporate('customers.view');

    // Another tenant's customer is reported exactly like a missing one. Every
    // section below is then keyed by this validated customer's id, so it
    // only ever returns that customer's own (same-tenant) records.
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId: tenant.tenantId },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found.');
    }

    const [
      allOrders,
      mochaBeans,
      preferredLocations,
      communicationPreferences,
      giftCards,
      notes,
      activityRows,
    ] = await Promise.all([
      this.orders.listForCustomer(customerId),
      this.loyalty.getLedgerSummaryForCustomer(customerId),
      this.preferredLocations.listForCustomer(customerId),
      this.preferences.getForCustomer(customerId),
      this.giftCards.getForCustomer(customerId),
      this.notes.listForCustomer(customerId, authorization, tenant),
      this.prisma.internalAuditEvent.findMany({
        where: {
          tenantId: tenant.tenantId,
          targetType: 'customer',
          targetId: customerId,
        },
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_LIMIT,
        select: {
          id: true,
          action: true,
          reason: true,
          createdAt: true,
          afterData: true,
          actorInternalUser: { select: { displayName: true, email: true } },
        },
      }),
    ]);

    const affordableRewards = await this.rewards.listActiveRewardsForCustomer(
      mochaBeans.balance,
      customer.tenantId,
    );

    return {
      customer: this.toSummary(customer),
      orders: {
        count: allOrders.length,
        recent: allOrders.slice(0, RECENT_ORDERS_LIMIT),
      },
      mochaBeans: {
        balance: mochaBeans.balance,
        recentActivity: mochaBeans.recentActivity,
      },
      affordableRewards: affordableRewards.filter((reward) => reward.canAfford),
      giftCards,
      preferredLocations,
      communicationPreferences,
      notes,
      activity: activityRows.map(toCustomerActivityItem),
    };
  }

  private toSummary(customer: CustomerRow): AdminCustomerSummary {
    return {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName,
      status: customer.status,
      emailVerified: customer.emailVerifiedAt !== null,
      marketingEmailOptIn: customer.marketingEmailOptIn,
      createdAt: customer.createdAt.toISOString(),
    };
  }
}
