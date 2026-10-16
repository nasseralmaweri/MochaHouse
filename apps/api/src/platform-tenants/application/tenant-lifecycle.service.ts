import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PLATFORM_ADMINISTRATOR_ROLE,
  PLATFORM_LIFECYCLE_RECENT_SIGN_IN_SECONDS,
  PLATFORM_OWNER_ALREADY_SIGNED_IN,
  PLATFORM_OWNER_EMAIL_IN_USE,
  PLATFORM_REAUTHENTICATION_REQUIRED,
  PLATFORM_TENANT_PROTECTED,
  type PlatformTenantLifecycleResponse,
  type PlatformTenantOwner,
  type PlatformTenantOwnerEmailResponse,
  type PlatformTenantStatusChangeResponse,
  type PlatformTenantSuspensionReason,
} from '@mocha-house/contracts';
import { Prisma, TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type {
  PlatformIdentity,
  PlatformOperatorRow,
} from '../../platform-auth/infrastructure/platform-identity';
import { isTenantId } from './platform-tenant-query';

// SC1e — a business's lifecycle, changed by a platform operator: suspend
// (with a reason), reactivate, and correct the first owner's email while
// they have never signed in. The SECOND (and last) platform service allowed
// to write a business's own rows (platform-write-boundary.spec.ts) — here
// only InternalUser.email, under the conditions below.
//
// Every change:
//   - needs a sign-in (with MFA) within the last 15 minutes (recent-sign-in
//     check), so an older or stolen session cannot make it;
//   - runs in one SERIALIZABLE transaction with its platform audit event;
//   - is a no-op (changed: false, no audit) when the business is already in
//     the requested state;
//   - is a conditional update, so two operators racing settle on one change.
//
// What suspension does is already enforced elsewhere (SC0.5a): the
// storefront answers 503 (a guest can still read an order's status), staff
// cannot enter the business, and the worker holds its notifications. Nothing
// is deleted; reactivation restores everything.

const NOT_FOUND = 'Tenant not found.';
const OWNER_NOT_FOUND = 'Owner not found.';
const OPEN_ORDER_STATUSES = [
  'RECEIVED',
  'ACCEPTED',
  'PREPARING',
  'READY',
] as const;

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: unknown;
    cause?: { originalCode?: unknown; code?: unknown };
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    e.code === 'P2002' ||
    e.cause?.originalCode === '23505' ||
    e.cause?.code === '23505' ||
    e.meta?.driverAdapterError?.cause?.originalCode === '23505'
  );
}

const CLOCK_SKEW_SECONDS = 60;

// L3 — the operator must have signed in recently. `now` is injectable for
// tests.
export function assertRecentSignIn(
  identity: PlatformIdentity | undefined,
  now: number = Date.now(),
): void {
  const signedInAt = identity?.authenticatedAt ?? null;
  const ageSeconds = signedInAt === null ? Infinity : now / 1000 - signedInAt;
  // A sign-in time in the future (beyond a minute of clock skew) is refused
  // too, like an unknown one.
  if (
    !(ageSeconds <= PLATFORM_LIFECYCLE_RECENT_SIGN_IN_SECONDS) ||
    ageSeconds < -CLOCK_SKEW_SECONDS
  ) {
    throw new UnauthorizedException({
      statusCode: 401,
      error: 'Unauthorized',
      code: PLATFORM_REAUTHENTICATION_REQUIRED,
      message: 'For your security, sign in again to make this change.',
    });
  }
}

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const OWNER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  externalSubject: true,
  lastAuthenticatedAt: true,
} as const;

function ownerView(row: {
  id: string;
  email: string;
  displayName: string | null;
  externalSubject: string | null;
  lastAuthenticatedAt: Date | null;
}): PlatformTenantOwner {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    signedIn: row.externalSubject !== null || row.lastAuthenticatedAt !== null,
  };
}

@Injectable()
export class TenantLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  async lifecycle(tenantId: string): Promise<PlatformTenantLifecycleResponse> {
    const tenant = await this.findTenant(this.prisma, tenantId);
    const [owner, openOrders, pendingNotifications] = await Promise.all([
      this.firstOwner(this.prisma, tenant.id),
      this.prisma.order.count({
        where: {
          tenantId: tenant.id,
          status: { in: [...OPEN_ORDER_STATUSES] },
        },
      }),
      this.prisma.outboxEvent.count({
        where: { tenantId: tenant.id, status: 'PENDING' },
      }),
    ]);
    return {
      tenantId: tenant.id,
      status: tenant.status,
      suspensionReason: tenant.suspensionReason,
      protected: tenant.id === TENANT_1_MOCHA_HOUSE_ID,
      owner: owner ? ownerView(owner) : null,
      impact: { openOrders, pendingNotifications },
    };
  }

  async suspend(
    tenantId: string,
    reason: PlatformTenantSuspensionReason,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformTenantStatusChangeResponse> {
    return runSerializable(this.prisma, async (tx) => {
      const tenant = await this.findTenant(tx, tenantId);
      // L2 — Tenant #1 is never suspended from the console.
      if (tenant.id === TENANT_1_MOCHA_HOUSE_ID) {
        throw conflict(
          PLATFORM_TENANT_PROTECTED,
          'This business cannot be suspended from the platform console.',
        );
      }
      if (tenant.status === 'SUSPENDED') {
        return {
          status: tenant.status,
          suspensionReason: tenant.suspensionReason,
          changed: false,
        };
      }
      const updated = await tx.tenant.updateMany({
        where: { id: tenant.id, status: 'ACTIVE' },
        data: { status: 'SUSPENDED', suspensionReason: reason },
      });
      if (updated.count === 0) {
        const now = await this.findTenant(tx, tenant.id);
        return {
          status: now.status,
          suspensionReason: now.suspensionReason,
          changed: false,
        };
      }
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.tenantSuspended,
        operator,
        tenant.id,
        reason,
        requestReference,
      );
      return { status: 'SUSPENDED', suspensionReason: reason, changed: true };
    });
  }

  async reactivate(
    tenantId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformTenantStatusChangeResponse> {
    return runSerializable(this.prisma, async (tx) => {
      const tenant = await this.findTenant(tx, tenantId);
      if (tenant.status === 'ACTIVE') {
        return { status: 'ACTIVE', suspensionReason: null, changed: false };
      }
      const updated = await tx.tenant.updateMany({
        where: { id: tenant.id, status: 'SUSPENDED' },
        data: { status: 'ACTIVE', suspensionReason: null },
      });
      if (updated.count === 0) {
        const now = await this.findTenant(tx, tenant.id);
        return {
          status: now.status,
          suspensionReason: now.suspensionReason,
          changed: false,
        };
      }
      // The reason it had been suspended for, for the record.
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.tenantReactivated,
        operator,
        tenant.id,
        tenant.suspensionReason,
        requestReference,
      );
      return { status: 'ACTIVE', suspensionReason: null, changed: true };
    });
  }

  async correctOwnerEmail(
    tenantId: string,
    ownerId: string,
    email: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformTenantOwnerEmailResponse> {
    try {
      return await runSerializable(this.prisma, async (tx) => {
        const tenant = await this.findTenant(tx, tenantId);
        const owner = await this.firstOwner(tx, tenant.id);
        if (!owner || owner.id !== ownerId) {
          throw new NotFoundException(OWNER_NOT_FOUND);
        }
        if (ownerView(owner).signedIn) {
          throw conflict(
            PLATFORM_OWNER_ALREADY_SIGNED_IN,
            'The owner has already signed in, so their email can no longer be corrected here.',
          );
        }
        if (owner.email === email) {
          return { owner: ownerView(owner), changed: false };
        }
        // Another staff member of THIS business with the address, in any
        // letter case (the database key is case-sensitive).
        const clash = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT "id" FROM "InternalUser"
          WHERE "tenantId" = ${tenant.id}
            AND "id" <> ${owner.id}
            AND LOWER("email") = LOWER(${email})
          LIMIT 1
        `);
        if (clash.length > 0) {
          throw conflict(
            PLATFORM_OWNER_EMAIL_IN_USE,
            'Another staff member of this business already uses that email.',
          );
        }
        // Compare-and-set: only while still never signed in.
        const updated = await tx.internalUser.updateMany({
          where: {
            id: owner.id,
            tenantId: tenant.id,
            externalSubject: null,
            lastAuthenticatedAt: null,
          },
          data: { email },
        });
        if (updated.count === 0) {
          throw conflict(
            PLATFORM_OWNER_ALREADY_SIGNED_IN,
            'The owner has already signed in, so their email can no longer be corrected here.',
          );
        }
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.tenantOwnerEmailCorrected,
          operator,
          tenant.id,
          null,
          requestReference,
        );
        return { owner: ownerView({ ...owner, email }), changed: true };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          PLATFORM_OWNER_EMAIL_IN_USE,
          'Another staff member of this business already uses that email.',
        );
      }
      throw error;
    }
  }

  // An unknown and a malformed id are the same 404.
  private async findTenant(db: Db, tenantId: string) {
    if (!isTenantId(tenantId)) throw new NotFoundException(NOT_FOUND);
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, status: true, suspensionReason: true },
    });
    if (!tenant) throw new NotFoundException(NOT_FOUND);
    return tenant;
  }

  // The first owner: the earliest staff member holding the built-in
  // administrator role at corporate scope.
  private firstOwner(db: Db, tenantId: string) {
    return db.internalUser.findFirst({
      where: {
        tenantId,
        roleAssignments: {
          some: {
            scopeType: 'CORPORATE',
            scopeId: null,
            role: { key: PLATFORM_ADMINISTRATOR_ROLE.key },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: OWNER_SELECT,
    });
  }

  private async audit(
    tx: Tx,
    action: string,
    operator: PlatformOperatorRow,
    tenantId: string,
    reasonCode: string | null,
    requestReference: string | undefined,
  ): Promise<void> {
    await tx.platformAuditEvent.create({
      data: {
        action,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        reasonCode,
        targetType: 'tenant',
        targetId: tenantId,
        requestReference: requestReference ?? null,
      },
    });
  }
}
