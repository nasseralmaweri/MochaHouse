import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BILLING_DOCUMENT_UNAVAILABLE,
  BILLING_UNAVAILABLE,
  type AdminBillingPaymentMethodResponse,
  type BillingInvoiceDocumentKind,
  type BillingInvoiceListResponse,
  type BillingInvoiceReason,
  type BillingInvoiceStatus,
  type BillingInvoiceView,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import { isProviderPage } from './billing-account.service';

// SC3e-1 — the business's billing history (owner decisions D1–D3), read-only:
//   * invoices from OUR history records (kept in line from verified provider
//     events and the reconciliation sweep), newest first, 20 a page — only
//     the business's own subscription's, matched by OUR ids;
//   * an invoice's document (the provider's hosted page or PDF) resolved for
//     ONE request: the invoice is re-read live and must still be that
//     business's (customer and subscription as recorded), the link the
//     provider's own host — never stored, never listed;
//   * the payment method the provider charges, as brand, last four and
//     expiry only (changing it stays the restricted Customer Portal).
// Nothing here charges, refunds or changes anything.

type BillingInvoice = Prisma.BillingInvoiceGetPayload<object>;

const PAGE_SIZE = 20;
// Drafts are not invoices to the business yet.
const SHOWN_STATUSES: BillingInvoiceStatus[] = [
  'open',
  'paid',
  'void',
  'uncollectible',
];

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: BILLING_UNAVAILABLE,
    message: "Billing details aren't available right now. Try again shortly.",
  });
}

function noDocument(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: BILLING_DOCUMENT_UNAVAILABLE,
    message: "This invoice's document isn't available.",
  });
}

function reasonOf(billingReason: string | null): BillingInvoiceReason {
  switch (billingReason) {
    case 'subscription_create':
      return 'SUBSCRIPTION_START';
    case 'subscription_cycle':
      return 'RENEWAL';
    case 'subscription_update':
      return 'PLAN_CHANGE';
    default:
      return 'OTHER';
  }
}

export function invoiceView(row: BillingInvoice): BillingInvoiceView {
  return {
    id: row.id,
    number: row.number,
    status: row.status as BillingInvoiceStatus,
    reason: reasonOf(row.billingReason),
    currency: row.currency.toUpperCase(),
    totalMinorUnits: row.totalMinorUnits,
    amountPaidMinorUnits: row.amountPaidMinorUnits,
    amountRemainingMinorUnits: row.amountRemainingMinorUnits,
    refundedOrCreditedMinorUnits: row.postPaymentCreditMinorUnits,
    creditAppliedMinorUnits:
      row.prePaymentCreditMinorUnits + row.balanceAppliedMinorUnits,
    periodStart: row.periodStart?.toISOString() ?? null,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    issuedAt: row.issuedAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
  };
}

// An opaque page position: the last invoice shown (issued time and id).
function encodeCursor(row: BillingInvoice): string {
  return Buffer.from(
    JSON.stringify({ t: row.issuedAt.toISOString(), i: row.id }),
  ).toString('base64url');
}

function decodeCursor(cursor: unknown): { t: Date; i: string } | null {
  if (cursor === undefined) return null;
  const invalid = () =>
    new BadRequestException('This page link is no longer valid.');
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > 200
  ) {
    throw invalid();
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { t?: unknown; i?: unknown };
    const at = typeof value.t === 'string' ? new Date(value.t) : null;
    if (
      at === null ||
      Number.isNaN(at.getTime()) ||
      typeof value.i !== 'string' ||
      !isUuid(value.i)
    ) {
      throw invalid();
    }
    return { t: at, i: value.i };
  } catch {
    throw invalid();
  }
}

export function parseInvoiceDocumentRequest(
  body: unknown,
): BillingInvoiceDocumentKind {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'kind'
  ) {
    throw new BadRequestException('Choose a document (kind).');
  }
  const kind = (body as { kind: unknown }).kind;
  if (kind !== 'invoice' && kind !== 'pdf') {
    throw new BadRequestException('Choose a document (kind).');
  }
  return kind;
}

@Injectable()
export class BillingHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  // A business's invoices (its own subscription's only).
  async list(
    tenantId: string,
    cursor: unknown,
  ): Promise<BillingInvoiceListResponse> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const after = decodeCursor(cursor);
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      select: { id: true },
    });
    if (!subscription) return { invoices: [], nextCursor: null };
    const rows = await this.prisma.billingInvoice.findMany({
      where: {
        subscriptionId: subscription.id,
        status: { in: SHOWN_STATUSES },
        ...(after
          ? {
              OR: [
                { issuedAt: { lt: after.t } },
                { issuedAt: after.t, id: { lt: after.i } },
              ],
            }
          : {}),
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    return {
      invoices: page.map(invoiceView),
      nextCursor:
        rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  // The provider's own page (or PDF) for one of THIS business's invoices.
  async documentLink(
    tenantId: string,
    invoiceId: string,
    kind: BillingInvoiceDocumentKind,
    actorInternalUserId: string,
  ): Promise<{ url: string }> {
    if (!isUuid(tenantId) || !isUuid(invoiceId)) {
      throw new NotFoundException('Invoice not found.');
    }
    const row = await this.prisma.billingInvoice.findFirst({
      where: {
        id: invoiceId,
        status: { in: SHOWN_STATUSES },
        subscription: { subscriberTenantId: tenantId },
      },
    });
    if (!row) throw new NotFoundException('Invoice not found.');
    if (!this.provider.available || row.provider !== this.provider.name) {
      throw unavailable();
    }
    let url: string | null;
    try {
      const live = await this.provider.retrieveInvoice(row.externalInvoiceId);
      const record = live?.record ?? null;
      if (
        record === null ||
        record.livemode !== this.provider.livemode ||
        record.externalInvoiceId !== row.externalInvoiceId ||
        record.externalCustomerId !== row.externalCustomerId ||
        record.externalSubscriptionId !== row.externalSubscriptionId ||
        record.status === 'draft'
      ) {
        throw noDocument();
      }
      url = kind === 'pdf' ? record.invoicePdfUrl : record.hostedInvoiceUrl;
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    if (
      url === null ||
      !isProviderPage(
        url,
        this.provider.name,
        kind === 'pdf' ? 'invoice-pdf' : 'invoice',
      )
    ) {
      throw noDocument();
    }
    await this.prisma.$transaction((tx) =>
      this.audit.recordBillingDocumentOpened(tx, {
        actorInternalUserId,
        subscriptionId: row.subscriptionId,
        invoiceId: row.id,
        kind,
      }),
    );
    return { url };
  }

  // What may be shown of the payment method the provider charges.
  async paymentMethod(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<AdminBillingPaymentMethodResponse> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
    });
    if (
      !subscription ||
      subscription.billingMode !== 'BILLED' ||
      subscription.externalSubscriptionId === null ||
      subscription.externalCustomerId === null
    ) {
      return { paymentMethod: null };
    }
    if (
      !this.provider.available ||
      subscription.billingProvider !== this.provider.name
    ) {
      throw unavailable();
    }
    try {
      const live = await this.provider.retrievePaymentMethod(
        subscription.externalSubscriptionId,
      );
      if (
        live.livemode !== this.provider.livemode ||
        live.externalSubscriptionId !== subscription.externalSubscriptionId ||
        live.externalCustomerId !== subscription.externalCustomerId
      ) {
        throw unavailable();
      }
      if (live.source === null) {
        return { paymentMethod: { kind: 'NONE', card: null } };
      }
      if (live.card === null) {
        return { paymentMethod: { kind: 'OTHER', card: null } };
      }
      // A card is usable through the last day of its expiry month (UTC).
      const expiresAfter = Date.UTC(live.card.expYear, live.card.expMonth, 1);
      return {
        paymentMethod: {
          kind: 'CARD',
          card: {
            brand: live.card.brand,
            last4: live.card.last4,
            expMonth: live.card.expMonth,
            expYear: live.card.expYear,
            expired: now.getTime() >= expiresAfter,
          },
        },
      };
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
  }
}
