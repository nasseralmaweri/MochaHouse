import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BILLING_UNAVAILABLE,
  PLATFORM_BILLING_CONTACT_NOT_ELIGIBLE,
  PLATFORM_BILLING_EXTENSION_LIMIT,
  PLATFORM_BILLING_NOT_EXTENDABLE,
  PLATFORM_BILLING_NOT_RECOVERABLE,
  type PlatformBillingContactView,
  type PlatformBillingOverview,
  type PlatformGraceExtension,
  type PlatformGraceExtensionKind,
  type PlatformGraceExtensionRequest,
} from '@mocha-house/contracts';
import {
  BILLING_MANAGE_PERMISSION,
  resolveBillingRecipient,
  type Prisma,
} from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import type { ProviderSubscriptionSnapshot } from '../domain/provider-sync';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import {
  BillingLifecycleError,
  BillingLifecycleService,
  GRACE_EXTENSION_EPISODE_MAX_DAYS,
  GRACE_EXTENSION_MAX_DAYS,
} from './billing-lifecycle.service';

// SC3c-3 — platform-operator billing operations: the business's designated
// billing contact (who CENTERIVO billing email goes to), grace extensions
// and exceptions, and the console's billing overview. Every change needs a
// recent sign-in (controller), is rate limited and audited.

// Review cases opened by the billing notification worker.
export const BILLING_CONTACT_MISSING_CASE = 'BILLING_CONTACT_MISSING';
export const BILLING_CONTACT_UNVERIFIED_CASE = 'BILLING_CONTACT_UNVERIFIED';
export const BILLING_NOTIFICATION_FAILED_CASE = 'BILLING_NOTIFICATION_FAILED';

const REASON_MIN = 10;
const REASON_MAX = 500;
// Printable text only (no control characters; line breaks allowed).
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: BILLING_UNAVAILABLE,
    message: 'Billing is not available right now. Nothing was changed.',
  });
}

function exactKeys(body: unknown, keys: string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Invalid request.');
  }
  const present = Object.keys(body).sort();
  if (present.join(',') !== [...keys].sort().join(',')) {
    throw new BadRequestException('Invalid request.');
  }
  return body as Record<string, unknown>;
}

export function parseGraceExtension(
  body: unknown,
): PlatformGraceExtensionRequest {
  const raw = exactKeys(body, ['days', 'reason']);
  const days = raw.days;
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > GRACE_EXTENSION_MAX_DAYS
  ) {
    throw new BadRequestException(
      `Choose a whole number of days from 1 to ${GRACE_EXTENSION_MAX_DAYS}.`,
    );
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (
    reason.length < REASON_MIN ||
    reason.length > REASON_MAX ||
    hasControlCharacter(reason)
  ) {
    throw new BadRequestException(
      `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`,
    );
  }
  return { days, reason };
}

export function parseContactAssignment(body: unknown): string {
  const raw = exactKeys(body, ['internalUserId']);
  if (typeof raw.internalUserId !== 'string' || !isUuid(raw.internalUserId)) {
    throw new BadRequestException('Choose a staff member.');
  }
  return raw.internalUserId;
}

// Staff of THIS business eligible to be DESIGNATED: ACTIVE, holding
// billing.manage business-wide (email verification is checked at delivery).
function designatableWhere(
  tenantId: string,
  internalUserId: string,
): Prisma.InternalUserWhereInput {
  return {
    id: internalUserId,
    tenantId,
    status: 'ACTIVE',
    roleAssignments: {
      some: {
        tenantId,
        scopeType: 'CORPORATE',
        scopeId: null,
        role: {
          tenantId,
          permissions: { some: { permissionKey: BILLING_MANAGE_PERMISSION } },
        },
      },
    },
  };
}

// The contact and extension part of the operator's billing view.
export async function billingOperationsView(
  prisma: PrismaService,
  tenantId: string,
  now: Date = new Date(),
): Promise<{
  contact: PlatformBillingContactView;
  extensions: PlatformGraceExtension[];
  extensionDaysRemaining: number | null;
}> {
  const resolution = await resolveBillingRecipient(prisma, tenantId, now);
  const subscription = await prisma.tenantSubscription.findUnique({
    where: { subscriberTenantId: tenantId },
    select: { id: true, status: true, pastDueAt: true, billingMode: true },
  });
  const rows = subscription
    ? await prisma.billingGraceExtension.findMany({
        where: { subscriptionId: subscription.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
    : [];
  let extensionDaysRemaining: number | null = null;
  if (
    subscription?.billingMode === 'BILLED' &&
    (subscription.status === 'PAST_DUE' || subscription.status === 'UNPAID') &&
    subscription.pastDueAt !== null
  ) {
    const used = rows
      .filter(
        (row) =>
          row.episodeStartedAt.getTime() === subscription.pastDueAt!.getTime(),
      )
      .reduce((sum, row) => sum + row.days, 0);
    extensionDaysRemaining = Math.max(
      0,
      GRACE_EXTENSION_EPISODE_MAX_DAYS - used,
    );
  }
  return {
    contact: resolution,
    extensions: rows.map((row) => ({
      id: row.id,
      kind: row.kind as PlatformGraceExtensionKind,
      days: row.days,
      previousEndsAt: row.previousEndsAt.toISOString(),
      newEndsAt: row.newEndsAt.toISOString(),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    extensionDaysRemaining,
  };
}

@Injectable()
export class BillingOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: BillingLifecycleService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  // --- billing contact ----------------------------------------------------------

  async assignContact(
    tenantId: string,
    internalUserId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<void> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    await runSerializable(this.prisma, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true },
      });
      if (!tenant) throw new NotFoundException('Business not found.');
      // Only a staff member of THIS business (never another's), ACTIVE and
      // holding billing.manage business-wide. The composite foreign key
      // refuses another business's staff even if this check were bypassed.
      const user = await tx.internalUser.findFirst({
        where: designatableWhere(tenantId, internalUserId),
        select: { id: true },
      });
      if (!user) {
        throw conflict(
          PLATFORM_BILLING_CONTACT_NOT_ELIGIBLE,
          'Choose an active staff member of this business who can manage billing.',
        );
      }
      const previous = await tx.tenantBillingContact.findUnique({
        where: { tenantId },
        select: { internalUserId: true },
      });
      await tx.tenantBillingContact.upsert({
        where: { tenantId },
        create: { tenantId, internalUserId: user.id },
        update: { internalUserId: user.id },
      });
      // Audited: the business, who was designated, and who was replaced
      // (identifiers only).
      const audit = (
        targetType: string,
        targetId: string,
        reasonCode: string | null,
      ) =>
        tx.platformAuditEvent.create({
          data: {
            action: PLATFORM_AUDIT_ACTIONS.billingContactAssigned,
            outcome: 'SUCCEEDED',
            reasonCode,
            actorPlatformOperatorId: operator.id,
            targetType,
            targetId,
            requestReference: requestReference ?? null,
          },
        });
      await audit('tenant', tenantId, null);
      await audit('internal_user', user.id, 'BILLING_CONTACT_DESIGNATED');
      if (previous && previous.internalUserId !== user.id) {
        await audit(
          'internal_user',
          previous.internalUserId,
          'BILLING_CONTACT_REPLACED',
        );
      }
    });
  }

  // --- grace extensions -----------------------------------------------------------

  async extendGrace(
    tenantId: string,
    input: PlatformGraceExtensionRequest,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<void> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      select: {
        id: true,
        billingMode: true,
        billingProvider: true,
        status: true,
        externalSubscriptionId: true,
        externalCustomerId: true,
      },
    });
    if (!subscription) throw new NotFoundException('Business not found.');
    if (
      subscription.billingMode !== 'BILLED' ||
      (subscription.status !== 'PAST_DUE' &&
        subscription.status !== 'UNPAID') ||
      subscription.externalSubscriptionId === null
    ) {
      throw conflict(
        PLATFORM_BILLING_NOT_EXTENDABLE,
        'Only a business with an unpaid invoice (past due or unpaid) can be given more time.',
      );
    }
    if (
      !this.provider.available ||
      subscription.billingProvider !== this.provider.name
    ) {
      throw unavailable();
    }
    // D6 — verified LIVE (before any lock) that the provider's subscription
    // is still ours, in test mode, and still recoverable. An ended one is
    // never extended (no stale access; a separate decision).
    let snapshot: ProviderSubscriptionSnapshot;
    try {
      snapshot = await this.provider.retrieveSubscription(
        subscription.externalSubscriptionId,
      );
    } catch (error) {
      if (
        error instanceof SaasBillingProviderError &&
        error.code === 'resource_missing'
      ) {
        throw notRecoverable();
      }
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    if (
      snapshot.externalSubscriptionId !== subscription.externalSubscriptionId ||
      snapshot.externalCustomerId !== subscription.externalCustomerId ||
      snapshot.livemode !== this.provider.livemode ||
      (snapshot.status !== 'past_due' && snapshot.status !== 'unpaid')
    ) {
      throw notRecoverable();
    }
    try {
      await this.lifecycle.extendGrace(
        subscription.id,
        {
          externalSubscriptionId: subscription.externalSubscriptionId,
          status: subscription.status,
        },
        input,
        operator.id,
        requestReference ?? null,
      );
    } catch (error) {
      if (error instanceof BillingLifecycleError) {
        if (error.reason === 'EXTENSION_LIMIT') {
          throw conflict(
            PLATFORM_BILLING_EXTENSION_LIMIT,
            `That is more than allowed: at most ${GRACE_EXTENSION_MAX_DAYS} days at a time and ${GRACE_EXTENSION_EPISODE_MAX_DAYS} days in total until the business pays.`,
          );
        }
        if (error.reason === 'NOT_EXTENDABLE' || error.reason === 'NOT_FOUND') {
          throw conflict(
            PLATFORM_BILLING_NOT_EXTENDABLE,
            "This business's billing changed meanwhile. Reload and try again.",
          );
        }
      }
      throw error;
    }
  }

  // --- console overview -------------------------------------------------------------

  async overview(now: Date = new Date()): Promise<PlatformBillingOverview> {
    const billed = { billingMode: 'BILLED' } as const;
    const [
      inGrace,
      unpaid,
      billingSuspended,
      graceExceptions,
      trialRecoveryWindows,
      missingContacts,
      failedNotifications,
      cases,
    ] = await Promise.all([
      this.prisma.tenantSubscription.count({
        where: { ...billed, status: 'PAST_DUE' },
      }),
      this.prisma.tenantSubscription.count({
        where: { ...billed, status: 'UNPAID' },
      }),
      this.prisma.tenant.count({
        where: { status: 'SUSPENDED', suspensionReason: 'BILLING' },
      }),
      this.prisma.tenantSubscription.count({
        where: {
          ...billed,
          status: 'UNPAID',
          graceExceptionEndsAt: { gt: now },
        },
      }),
      this.prisma.tenantSubscription.count({
        where: {
          ...billed,
          status: 'TRIAL_EXPIRED',
          recoveryEndsAt: { not: null },
        },
      }),
      this.prisma.billingReconciliationCase.count({
        // No one eligible, or the designated contact unable to receive.
        where: {
          status: 'OPEN',
          kind: {
            in: [BILLING_CONTACT_MISSING_CASE, BILLING_CONTACT_UNVERIFIED_CASE],
          },
        },
      }),
      this.prisma.billingNotification.count({ where: { status: 'FAILED' } }),
      this.prisma.billingReconciliationCase.groupBy({
        by: ['kind'],
        where: { status: 'OPEN' },
        _count: { _all: true },
        orderBy: { kind: 'asc' },
      }),
    ]);
    return {
      inGrace,
      unpaid,
      billingSuspended,
      graceExceptions,
      trialRecoveryWindows,
      missingContacts,
      failedNotifications,
      openCases: cases.map((row) => ({
        kind: row.kind,
        count: row._count._all,
      })),
    };
  }
}

function notRecoverable(): ConflictException {
  return conflict(
    PLATFORM_BILLING_NOT_RECOVERABLE,
    "The billing provider has ended this business's subscription, so it can't be given more time. Nothing was changed.",
  );
}
