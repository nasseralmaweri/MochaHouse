import { ConflictException, Injectable } from '@nestjs/common';
import {
  REGISTRATION_CONTROL_UNCHANGED,
  type PlatformOnboardingBusinessListResponse,
  type PlatformOnboardingBusinessRow,
  type PlatformRegistrationControlChange,
  type PlatformRegistrationControlView,
  type PlatformRegistrationIssue,
  type PlatformRegistrationListResponse,
  type PlatformRegistrationRow,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { MAX_VERIFICATION_ATTEMPTS } from '../../owner-registration/application/owner-registration.service';
import {
  REGISTRATION_CONTROL_LOCK,
  REGISTRATION_QUOTA_WINDOW_MS,
  configuredDailyLimit,
  latestRegistrationControl,
  registrationFlagState,
  registrationQuotaWindow,
} from '../../owner-registration/application/registration-control';
import { onboardingProgress } from '../../locations/application/location-readiness';
import type {
  OnboardingListQuery,
  RegistrationControlInput,
  RegistrationListQuery,
} from './platform-onboarding-query';

// SC4e — the Platform Console's onboarding oversight (owner decisions
// E1–E6). Platform data and live business progress, read across businesses
// by design, for operators only (the controller requires onboarding.view /
// onboarding.manage on every route). Nothing here acts as a business or its
// owner, deletes a registration or touches identity verification; the only
// write is the registration pause.
//
// Never exposed: verification codes, passwords, the server-only initial
// password nonce, login identifiers (identity provider subject) or tokens.
// An unverified email is masked.

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 20;
// The most recent self-service businesses whose progress is computed live
// per request, and the batch size (each batch is a fixed handful of queries).
export const ONBOARDING_SCAN_LIMIT = 5_000;
const PROGRESS_BATCH = 200;

type RegistrationWhere = Prisma.OwnerRegistrationWhereInput;

// "j***@example.com": the first character of the local part, the domain in
// full (it helps spot an abusive domain without revealing the person).
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

@Injectable()
export class PlatformOnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  // --- registrations ------------------------------------------------------

  private issueWhere(
    now: Date,
  ): Record<PlatformRegistrationIssue, RegistrationWhere> {
    return {
      EXPIRED: { status: { not: 'VERIFIED' }, expiresAt: { lt: now } },
      STALLED: {
        status: { not: 'VERIFIED' },
        expiresAt: { gte: now },
        OR: [
          { status: 'PASSWORD_SETUP' },
          { verificationAttempts: { gte: MAX_VERIFICATION_ATTEMPTS } },
        ],
      },
      NO_BUSINESS: { status: 'VERIFIED', provisionedTenantId: null },
    };
  }

  async registrations(
    query: RegistrationListQuery,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformRegistrationListResponse> {
    const now = new Date();
    const issues = this.issueWhere(now);
    const byFilter: Record<RegistrationListQuery['filter'], RegistrationWhere> =
      {
        all: {},
        pending: { status: 'PENDING_VERIFICATION' },
        'password-setup': { status: 'PASSWORD_SETUP' },
        verified: { status: 'VERIFIED' },
        'with-business': { provisionedTenantId: { not: null } },
        expired: issues.EXPIRED,
        stalled: issues.STALLED,
        'no-business': issues.NO_BUSINESS,
      };
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.createdFrom) {
      createdAt.gte = new Date(`${query.createdFrom}T00:00:00.000Z`);
    }
    if (query.createdTo) {
      createdAt.lt = new Date(
        new Date(`${query.createdTo}T00:00:00.000Z`).getTime() + DAY_MS,
      );
    }
    const where: RegistrationWhere = {
      AND: [
        byFilter[query.filter],
        query.createdFrom || query.createdTo ? { createdAt } : {},
      ],
    };

    const [total, rows] = await Promise.all([
      this.prisma.ownerRegistration.count({ where }),
      this.prisma.ownerRegistration.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        // Deliberately no identitySubject, initialPasswordNonce or provider.
        select: {
          id: true,
          email: true,
          status: true,
          createdAt: true,
          verifiedAt: true,
          expiresAt: true,
          codesSent: true,
          verificationAttempts: true,
          provisionedTenantId: true,
          provisionedAt: true,
        },
      }),
    ]);
    const tenantIds = rows
      .map((row) => row.provisionedTenantId)
      .filter((id): id is string => id !== null);
    const tenants = tenantIds.length
      ? await this.prisma.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameOf = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));

    // Reading owner email addresses is audited (who looked, when).
    await this.prisma.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.onboardingRegistrationsViewed,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        reasonCode: `FILTER_${query.filter.toUpperCase().replace(/-/g, '_')}`,
        requestReference: requestReference ?? null,
      },
    });

    return {
      items: rows.map((row): PlatformRegistrationRow => {
        const verified = row.status === 'VERIFIED';
        let issue: PlatformRegistrationIssue | null = null;
        if (!verified && row.expiresAt < now) issue = 'EXPIRED';
        else if (
          !verified &&
          (row.status === 'PASSWORD_SETUP' ||
            row.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS)
        ) {
          issue = 'STALLED';
        } else if (verified && row.provisionedTenantId === null) {
          issue = 'NO_BUSINESS';
        }
        return {
          id: row.id,
          email: verified ? row.email : maskEmail(row.email),
          emailMasked: !verified,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          verifiedAt: iso(row.verifiedAt),
          codeExpiresAt: verified ? null : row.expiresAt.toISOString(),
          codesSent: row.codesSent,
          failedAttempts: row.verificationAttempts,
          business:
            row.provisionedTenantId && row.provisionedAt
              ? {
                  id: row.provisionedTenantId,
                  name: nameOf.get(row.provisionedTenantId) ?? '',
                  createdAt: row.provisionedAt.toISOString(),
                }
              : null,
          issue,
        };
      }),
      filter: query.filter,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  // --- registration control ----------------------------------------------

  async registrationControl(): Promise<PlatformRegistrationControlView> {
    const now = new Date();
    const issues = this.issueWhere(now);
    const flag = registrationFlagState();
    const limit = configuredDailyLimit();
    const [history, quota, expired, stalled, verifiedWithoutBusiness] =
      await Promise.all([
        this.prisma.registrationControlChange.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: HISTORY_LIMIT,
          select: {
            paused: true,
            reason: true,
            createdAt: true,
            actorPlatformOperator: { select: { email: true } },
          },
        }),
        registrationQuotaWindow(this.prisma, now),
        this.prisma.ownerRegistration.count({ where: issues.EXPIRED }),
        this.prisma.ownerRegistration.count({ where: issues.STALLED }),
        this.prisma.ownerRegistration.count({ where: issues.NO_BUSINESS }),
      ]);
    const changes = history.map((row): PlatformRegistrationControlChange => ({
      paused: row.paused,
      reason: row.reason,
      operatorEmail: row.actorPlatformOperator.email,
      at: row.createdAt.toISOString(),
    }));
    const paused = changes[0]?.paused ?? false;
    const full = limit !== null && quota.used >= limit;
    return {
      flag,
      paused,
      accepting: flag === 'ON' && !paused,
      lastChange: changes[0] ?? null,
      history: changes,
      quota: {
        limit,
        usedInWindow: quota.used,
        windowHours: 24,
        nextFreeAt:
          full && quota.oldestAt
            ? new Date(
                quota.oldestAt.getTime() + REGISTRATION_QUOTA_WINDOW_MS,
              ).toISOString()
            : null,
        asOf: now.toISOString(),
      },
      issues: { expired, stalled, verifiedWithoutBusiness },
    };
  }

  // Pause or resume NEW registrations. Serialized (advisory lock), so two
  // operators can never record the same change twice; the history row and
  // its audit event commit together. Never touches the deployment flag: a
  // resume while the flag is off changes nothing about availability.
  async changeRegistrationControl(
    input: RegistrationControlInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformRegistrationControlView> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${REGISTRATION_CONTROL_LOCK}::bigint)`;
      const current = (await latestRegistrationControl(tx))?.paused ?? false;
      if (current === input.paused) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: REGISTRATION_CONTROL_UNCHANGED,
          message: input.paused
            ? 'New registrations are already paused.'
            : 'New registrations are not paused.',
        });
      }
      const change = await tx.registrationControlChange.create({
        data: {
          paused: input.paused,
          reason: input.reason,
          actorPlatformOperatorId: operator.id,
        },
        select: { id: true },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: input.paused
            ? PLATFORM_AUDIT_ACTIONS.registrationPaused
            : PLATFORM_AUDIT_ACTIONS.registrationResumed,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          targetType: 'registration_control',
          targetId: change.id,
          requestReference: requestReference ?? null,
        },
      });
    });
    return this.registrationControl();
  }

  // --- onboarding progress -------------------------------------------------

  async businesses(
    query: OnboardingListQuery,
  ): Promise<PlatformOnboardingBusinessListResponse> {
    const now = Date.now();
    const registrations = await this.prisma.ownerRegistration.findMany({
      where: { provisionedTenantId: { not: null } },
      orderBy: [{ provisionedAt: 'desc' }, { id: 'desc' }],
      take: ONBOARDING_SCAN_LIMIT + 1,
      select: {
        createdAt: true,
        provisionedAt: true,
        provisionedTenantId: true,
      },
    });
    const truncated = registrations.length > ONBOARDING_SCAN_LIMIT;
    const scanned = registrations.slice(0, ONBOARDING_SCAN_LIMIT);

    const rows: PlatformOnboardingBusinessRow[] = [];
    for (let start = 0; start < scanned.length; start += PROGRESS_BATCH) {
      const batch = scanned.slice(start, start + PROGRESS_BATCH);
      const ids = batch.map((row) => row.provisionedTenantId!);
      const [progress, tenants] = await Promise.all([
        onboardingProgress(this.prisma, ids),
        this.prisma.tenant.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, slug: true, status: true },
        }),
      ]);
      const tenantOf = new Map(tenants.map((tenant) => [tenant.id, tenant]));
      for (const registration of batch) {
        const tenantId = registration.provisionedTenantId!;
        const tenant = tenantOf.get(tenantId);
        const state = progress.get(tenantId);
        if (!tenant || !state) continue;
        const createdAt = registration.provisionedAt!;
        rows.push({
          tenantId,
          name: tenant.name,
          slug: tenant.slug,
          tenantStatus: tenant.status,
          registeredAt: registration.createdAt.toISOString(),
          businessCreatedAt: createdAt.toISOString(),
          steps: state.steps,
          completedCount: state.completedCount,
          totalCount: state.totalCount,
          setupComplete: state.setupComplete,
          stuck:
            !state.setupComplete &&
            now - createdAt.getTime() > query.stuckDays * DAY_MS,
        });
      }
    }

    const done = (row: PlatformOnboardingBusinessRow, key: string) =>
      row.steps.find((step) => step.key === key)?.done ?? false;
    const matches: Record<
      OnboardingListQuery['filter'],
      (row: PlatformOnboardingBusinessRow) => boolean
    > = {
      all: () => true,
      'awaiting-payment': (row) => !done(row, 'billing'),
      'missing-location': (row) => !done(row, 'location'),
      'missing-hours': (row) => done(row, 'location') && !done(row, 'hours'),
      'missing-menu': (row) => done(row, 'location') && !done(row, 'menu'),
      'ordering-off': (row) => done(row, 'location') && !done(row, 'ordering'),
      stuck: (row) => row.stuck,
    };
    const filtered = rows.filter(matches[query.filter]);
    const count = (filter: OnboardingListQuery['filter']) =>
      rows.filter(matches[filter]).length;

    return {
      items: filtered.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      ),
      filter: query.filter,
      stuckDays: query.stuckDays,
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      scanned: scanned.length,
      scanLimit: ONBOARDING_SCAN_LIMIT,
      truncated,
      summary: {
        businesses: rows.length,
        complete: rows.filter((row) => row.setupComplete).length,
        awaitingPayment: count('awaiting-payment'),
        missingLocation: count('missing-location'),
        missingHours: count('missing-hours'),
        missingMenu: count('missing-menu'),
        orderingOff: count('ordering-off'),
        stuck: count('stuck'),
      },
    };
  }
}
