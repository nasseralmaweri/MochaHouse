import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PAYMENT_ACCOUNT_NEEDS_SUPPORT,
  PAYMENT_ACCOUNT_OWNER_ONLY,
  PAYMENTS_PROVIDER_UNAVAILABLE,
  PLATFORM_ADMINISTRATOR_ROLE,
  type AdminPaymentAccountResponse,
  type AdminPaymentOnboardingResponse,
  type PaymentAccountState,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import {
  CONNECT_ACCOUNT_PROVIDER,
  ConnectProviderError,
  type ConnectAccountProvider,
  type VerifiedConnectEvent,
} from '../provider/connect-account-provider';
import {
  connectCountry,
  connectReturnUrl,
} from '../provider/connect-provider-mode';

// ESP-04 M1 — the restaurant's own connected payment account (Stripe Connect,
// Accounts v2). Restaurant customer payments only; CENTERIVO's SaaS billing
// is never touched. Nothing here can move money, and customer payments stay
// disabled whatever the account's state.
//
//   * OWNER ONLY: the caller must hold payments.connect (checked by the
//     guard) AND the business's built-in administrator role at corporate
//     scope (checked here, from the database).
//   * ONE account per business, never a duplicate: our record is created
//     first (unique per business) and the provider account is created with
//     an idempotency key derived from that record, so a retry, a double
//     click or a concurrent request gets the same account back. Once
//     recorded, the account id never changes (database guard).
//   * The account's state is ALWAYS what Stripe reports when we read it back
//     (on return from onboarding, on refresh, and on every verified webhook)
//     — never inferred from a redirect or an event body.

type TenantPaymentAccount = Prisma.TenantPaymentAccountGetPayload<
  Record<string, never>
>;

// Stripe honours an idempotency key for at least 24 hours. Within this
// window a retry gets the account already created; past it, an account whose
// id we never recorded is NOT created again automatically (that could make a
// second account) — it goes to CENTERIVO support instead.
export const ACCOUNT_CREATION_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export const APPROVED_CONFIGURATION = {
  dashboard: 'full',
  feesCollector: 'stripe',
  lossesCollector: 'stripe',
} as const;

@Injectable()
export class PaymentAccountsService {
  private readonly logger = new Logger(PaymentAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    @Inject(CONNECT_ACCOUNT_PROVIDER)
    private readonly provider: ConnectAccountProvider,
  ) {}

  // The business's built-in administrator (owner), at corporate scope.
  async assertOwner(tenantId: string, internalUserId: string): Promise<void> {
    const owner = await this.prisma.internalUserRoleAssignment.findFirst({
      where: {
        tenantId,
        internalUserId,
        scopeType: 'CORPORATE',
        scopeId: null,
        role: {
          tenantId,
          key: PLATFORM_ADMINISTRATOR_ROLE.key,
          isSystem: true,
        },
        internalUser: { tenantId, status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!owner) {
      throw new ForbiddenException({
        code: PAYMENT_ACCOUNT_OWNER_ONLY,
        message:
          "Only the restaurant's owner can connect or manage its payment account.",
      });
    }
  }

  async account(tenantId: string): Promise<AdminPaymentAccountResponse> {
    const row = await this.prisma.tenantPaymentAccount.findUnique({
      where: { tenantId },
    });
    return this.response(row);
  }

  // Creates the restaurant's account if it has none (never a second one)
  // and returns Stripe's hosted onboarding page for it.
  async startOnboarding(
    tenantId: string,
    actorInternalUserId: string,
  ): Promise<AdminPaymentOnboardingResponse> {
    this.assertAvailable();
    const returnUrl = connectReturnUrl();
    if (!returnUrl) throw unavailable();

    const row = await this.ensureRecord(tenantId, actorInternalUserId);
    const accountId = row.externalAccountId ?? (await this.createAccount(row));

    const back = (connect: 'return' | 'refresh') => {
      const url = new URL(returnUrl);
      url.searchParams.set('connect', connect);
      return url.toString();
    };
    let link: { url: string };
    try {
      link = await this.provider.createOnboardingLink({
        accountId,
        refreshUrl: back('refresh'),
        returnUrl: back('return'),
      });
    } catch (error) {
      if (error instanceof ConnectProviderError) throw unavailable();
      throw error;
    }
    await this.prisma.$transaction((tx) =>
      this.audit.recordPaymentAccountAction(tx, {
        actorInternalUserId,
        action: 'payments.onboarding_opened',
        paymentAccountId: row.id,
        externalAccountId: accountId,
      }),
    );
    return { url: link.url };
  }

  // Reads the account back from Stripe now (after returning from
  // onboarding, or on request).
  async refresh(tenantId: string): Promise<AdminPaymentAccountResponse> {
    this.assertAvailable();
    const row = await this.prisma.tenantPaymentAccount.findUnique({
      where: { tenantId },
    });
    if (!row?.externalAccountId) return this.response(row);
    try {
      return this.response(await this.sync(row));
    } catch (error) {
      if (error instanceof ConnectProviderError) throw unavailable();
      throw error;
    }
  }

  // A verified webhook event: recorded once, then — for an account event
  // about an account of ours — the account is read back from Stripe.
  // Returns false when it should be retried (the provider retries on 503).
  async handleEvent(event: VerifiedConnectEvent): Promise<boolean> {
    let stored = await this.prisma.restaurantPaymentProviderEvent.findUnique({
      where: {
        provider_externalEventId: {
          provider: event.provider,
          externalEventId: event.externalEventId,
        },
      },
    });
    if (
      stored &&
      (stored.status === 'PROCESSED' || stored.status === 'IGNORED')
    ) {
      return true; // A duplicate delivery: already handled.
    }
    // Only account events are recorded; anything else the endpoint is sent
    // is acknowledged and dropped (the endpoint should subscribe to account
    // events only), so the table cannot grow from unrelated traffic.
    if (!stored && !isAccountEvent(event.type)) return true;
    if (!stored) {
      try {
        stored = await this.prisma.restaurantPaymentProviderEvent.create({
          data: {
            provider: event.provider,
            externalEventId: event.externalEventId,
            type: event.type,
            livemode: event.livemode,
            externalAccountId: event.externalAccountId,
            payloadDigest: event.payloadDigest,
          },
        });
      } catch (error) {
        // A concurrent delivery of the same event recorded it first.
        if (isUniqueViolation(error)) return true;
        throw error;
      }
    }
    const settle = (
      status: 'PROCESSED' | 'IGNORED' | 'FAILED',
      outcome: string,
    ) =>
      this.prisma.restaurantPaymentProviderEvent.update({
        where: { id: stored.id },
        data: {
          status,
          outcome,
          attempts: { increment: 1 },
          processedAt: status === 'FAILED' ? null : new Date(),
        },
      });

    if (event.livemode) {
      await settle('IGNORED', 'LIVE_MODE_REFUSED');
      return true;
    }
    if (!isAccountEvent(event.type)) {
      await settle('IGNORED', 'UNHANDLED_TYPE');
      return true;
    }
    if (!event.externalAccountId) {
      await settle('IGNORED', 'NO_ACCOUNT');
      return true;
    }
    // The business is found from OUR stored account id only.
    const row = await this.prisma.tenantPaymentAccount.findUnique({
      where: { externalAccountId: event.externalAccountId },
    });
    if (!row) {
      await settle('IGNORED', 'UNKNOWN_ACCOUNT');
      return true;
    }
    try {
      await this.sync(row);
    } catch (error) {
      this.logger.warn(
        `Connect event ${stored.id}: the account could not be read back (${
          error instanceof ConnectProviderError ? error.code : 'error'
        })`,
      );
      await settle('FAILED', 'ACCOUNT_READ_FAILED');
      return false;
    }
    await settle('PROCESSED', 'ACCOUNT_SYNCED');
    return true;
  }

  // --- internals ---------------------------------------------------------------

  private assertAvailable(): void {
    if (!this.provider.available) throw unavailable();
  }

  // Our record of the business's account (created once; unique per
  // business). Never a provider call.
  private async ensureRecord(
    tenantId: string,
    actorInternalUserId: string,
  ): Promise<TenantPaymentAccount> {
    const existing = await this.prisma.tenantPaymentAccount.findUnique({
      where: { tenantId },
    });
    if (existing) return existing;
    try {
      return await this.prisma.tenantPaymentAccount.create({
        data: {
          tenantId,
          provider: this.provider.name,
          livemode: false,
          connectedByInternalUserId: actorInternalUserId,
        },
      });
    } catch (error) {
      // A concurrent request created it first: use that one.
      if (isUniqueViolation(error)) {
        return this.prisma.tenantPaymentAccount.findUniqueOrThrow({
          where: { tenantId },
        });
      }
      throw error;
    }
  }

  // Creates the provider account for our record, idempotently (the key is
  // our record's id), and records its id exactly once.
  private async createAccount(row: TenantPaymentAccount): Promise<string> {
    const [tenant, actor] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: row.tenantId },
        select: { name: true },
      }),
      this.prisma.internalUser.findFirst({
        where: { id: row.connectedByInternalUserId, tenantId: row.tenantId },
        select: { email: true },
      }),
    ]);
    // Mark the request before calling the provider (once), so a request
    // whose account id was never recorded is recognised later.
    const requestedAt =
      row.creationRequestedAt ??
      (
        await this.prisma.tenantPaymentAccount.update({
          where: { id: row.id },
          data: { creationRequestedAt: new Date() },
        })
      ).creationRequestedAt!;
    if (Date.now() - requestedAt.getTime() > ACCOUNT_CREATION_RETRY_WINDOW_MS) {
      throw new ConflictException({
        code: PAYMENT_ACCOUNT_NEEDS_SUPPORT,
        message:
          'Connecting your Stripe account needs a quick check by CENTERIVO support before it can continue. Nothing was created or charged.',
      });
    }
    let created: { accountId: string };
    try {
      created = await this.provider.createAccount({
        idempotencyKey: `centerivo-connect-account-${row.id}`,
        tenantId: row.tenantId,
        displayName: tenant.name,
        contactEmail: actor?.email ?? null,
        country: connectCountry(),
      });
    } catch (error) {
      if (error instanceof ConnectProviderError) throw unavailable();
      throw error;
    }
    const recorded = await this.prisma.$transaction(async (tx) => {
      const set = await tx.tenantPaymentAccount.updateMany({
        where: { id: row.id, tenantId: row.tenantId, externalAccountId: null },
        data: { externalAccountId: created.accountId },
      });
      if (set.count === 1) {
        await this.audit.recordPaymentAccountAction(tx, {
          actorInternalUserId: row.connectedByInternalUserId,
          action: 'payments.account_created',
          paymentAccountId: row.id,
          externalAccountId: created.accountId,
        });
      }
      return tx.tenantPaymentAccount.findUniqueOrThrow({
        where: { id: row.id },
      });
    });
    // A concurrent request recorded the account first: with the same
    // idempotency key it must be the same account.
    if (recorded.externalAccountId !== created.accountId) {
      throw new ConflictException(
        'The payment account changed while it was being connected. Refresh and try again.',
      );
    }
    return created.accountId;
  }

  // Reads the account back from the provider and stores what it reports.
  private async sync(row: TenantPaymentAccount): Promise<TenantPaymentAccount> {
    const snapshot = await this.provider.retrieveAccount(
      row.externalAccountId!,
    );
    if (snapshot.livemode || snapshot.accountId !== row.externalAccountId) {
      throw new ConnectProviderError('account_mismatch');
    }
    return this.prisma.tenantPaymentAccount.update({
      where: { id: row.id },
      data: {
        dashboard: snapshot.dashboard,
        feesCollector: snapshot.feesCollector,
        lossesCollector: snapshot.lossesCollector,
        cardPaymentsStatus: snapshot.cardPaymentsStatus,
        requirementsStatus: snapshot.requirementsStatus,
        requirementsDue: Math.max(0, snapshot.requirementsDue),
        closed: snapshot.closed,
        lastSyncedAt: new Date(),
      },
    });
  }

  private response(
    row: TenantPaymentAccount | null,
  ): AdminPaymentAccountResponse {
    return {
      providerAvailable: this.provider.available,
      state: stateOf(row),
      accountId: row?.externalAccountId ?? null,
      testMode: true,
      requirementsDue: row?.requirementsDue ?? 0,
      lastCheckedAt: row?.lastSyncedAt?.toISOString() ?? null,
      paymentsEnabled: false,
    };
  }
}

// Where the account stands, from what Stripe last reported. Only an account
// whose card payments are active AND whose configuration is the approved one
// (restaurant pays fees, full dashboard, Stripe-managed losses) is READY.
export function stateOf(
  row: Pick<
    TenantPaymentAccount,
    | 'externalAccountId'
    | 'closed'
    | 'lastSyncedAt'
    | 'dashboard'
    | 'feesCollector'
    | 'lossesCollector'
    | 'cardPaymentsStatus'
    | 'requirementsStatus'
    | 'requirementsDue'
  > | null,
): PaymentAccountState {
  if (!row?.externalAccountId) return 'NOT_CONNECTED';
  if (row.closed) return 'CLOSED';
  if (!row.lastSyncedAt) return 'SETUP_IN_PROGRESS';
  if (
    row.dashboard !== APPROVED_CONFIGURATION.dashboard ||
    row.feesCollector !== APPROVED_CONFIGURATION.feesCollector ||
    row.lossesCollector !== APPROVED_CONFIGURATION.lossesCollector
  ) {
    return 'CONFIGURATION_MISMATCH';
  }
  switch (row.cardPaymentsStatus) {
    case 'unsupported':
      return 'NOT_SUPPORTED';
    case 'active':
      return row.requirementsStatus === 'past_due'
        ? 'ACTION_REQUIRED'
        : 'READY';
    case 'restricted':
      return row.requirementsDue > 0 ? 'ACTION_REQUIRED' : 'UNDER_REVIEW';
    case 'pending':
      return row.requirementsDue > 0 ? 'SETUP_IN_PROGRESS' : 'UNDER_REVIEW';
    default:
      return 'SETUP_IN_PROGRESS';
  }
}

// Classic (account.updated, account.application.*) and v2
// (v2.core.account.updated, v2.core.account[...]...) account events.
export function isAccountEvent(type: string): boolean {
  return (
    type === 'account.updated' ||
    type.startsWith('account.application.') ||
    type === 'v2.core.account.updated' ||
    type === 'v2.core.account.closed' ||
    type.startsWith('v2.core.account[')
  );
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: PAYMENTS_PROVIDER_UNAVAILABLE,
    message:
      'Connecting a payment account is not available right now. Nothing was changed.',
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
