import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PLATFORM_ADDON_IN_PLAN,
  PLATFORM_NO_SUBSCRIPTION,
  PLATFORM_PLAN_VERSION_NOT_PUBLISHED,
  isOptionalModuleKey,
  type OptionalModuleKey,
  type PlatformSubscriptionChangeResponse,
  type PlatformSubscriptionPreviewResponse,
  type PlatformTenantSubscriptionResponse,
  type SubscriptionModuleKey,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { effectiveModules } from '../../subscriptions/application/entitlements.service';
import { isUuid, type SubscriptionChange } from './plan-input';

// SC2a — a business's subscription, managed by a platform operator:
// assign or change its plan (a PUBLISHED version only), grant or revoke an
// add-on module, and PREVIEW any of these first (what the business would
// gain or lose) without changing anything.
//
// A change applies to new operations immediately and destroys nothing: no
// business data is deleted, open orders keep going (orders are core), and
// the money a business already holds stays correctable (lifecycle-retained
// permissions, see LIFECYCLE_RETAINED_PERMISSIONS). Each change is one
// SERIALIZABLE transaction with its history row and platform audit event;
// a request for the current state is a no-op (changed: false).

const NOT_FOUND = 'Tenant not found.';
const VERSION_NOT_FOUND = 'Plan version not found.';

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

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const SUBSCRIPTION_INCLUDE = {
  planVersion: { include: { plan: true } },
  moduleGrants: { orderBy: { moduleKey: 'asc' } },
  events: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    include: {
      fromPlanVersion: { include: { plan: true } },
      toPlanVersion: { include: { plan: true } },
    },
  },
} as const satisfies Prisma.TenantSubscriptionInclude;

type SubscriptionRow = Prisma.TenantSubscriptionGetPayload<{
  include: typeof SUBSCRIPTION_INCLUDE;
}>;

function sorted(
  modules: Iterable<SubscriptionModuleKey>,
): SubscriptionModuleKey[] {
  return [...modules].sort((a, b) =>
    a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b),
  );
}

function label(
  version: { version: number; plan: { name: string } } | null,
): string | null {
  return version ? `${version.plan.name} v${version.version}` : null;
}

function optional(keys: readonly string[]): OptionalModuleKey[] {
  return keys.filter((key): key is OptionalModuleKey =>
    isOptionalModuleKey(key),
  );
}

function view(
  tenantId: string,
  row: SubscriptionRow | null,
): PlatformTenantSubscriptionResponse {
  if (!row) {
    return { tenantId, subscription: null, modules: ['core'], history: [] };
  }
  const addOns = optional(row.moduleGrants.map((grant) => grant.moduleKey));
  return {
    tenantId,
    subscription: {
      id: row.id,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      plan: {
        id: row.planVersion.plan.id,
        key: row.planVersion.plan.key,
        name: row.planVersion.plan.name,
      },
      version: {
        id: row.planVersion.id,
        version: row.planVersion.version,
        status: row.planVersion.status,
      },
      addOns,
    },
    modules: sorted(effectiveModules(row.planVersion.moduleKeys, addOns)),
    history: row.events.map((event) => ({
      type: event.type,
      at: event.createdAt.toISOString(),
      fromVersion: label(event.fromPlanVersion),
      toVersion: label(event.toPlanVersion),
      moduleKey:
        event.moduleKey && isOptionalModuleKey(event.moduleKey)
          ? event.moduleKey
          : null,
    })),
  };
}

@Injectable()
export class TenantSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string): Promise<PlatformTenantSubscriptionResponse> {
    await this.findTenant(this.prisma, tenantId);
    return view(tenantId, await this.load(this.prisma, tenantId));
  }

  // L7 (owner clarification 7) — what a change would do, without doing it.
  async preview(
    tenantId: string,
    change: SubscriptionChange,
  ): Promise<PlatformSubscriptionPreviewResponse> {
    await this.findTenant(this.prisma, tenantId);
    const row = await this.load(this.prisma, tenantId);
    const planKeys = row?.planVersion.moduleKeys ?? null;
    const addOns = optional(row?.moduleGrants.map((g) => g.moduleKey) ?? []);
    const current = row
      ? effectiveModules(planKeys ?? [], addOns)
      : effectiveModules([], []);

    let proposed: Set<SubscriptionModuleKey>;
    if (change.kind === 'plan') {
      const version = await this.publishedVersion(
        this.prisma,
        change.planVersionId,
      );
      proposed = effectiveModules(version.moduleKeys, addOns);
    } else {
      if (!row) {
        throw conflict(
          PLATFORM_NO_SUBSCRIPTION,
          'This business has no subscription. Assign a plan first.',
        );
      }
      const nextAddOns =
        change.kind === 'grant'
          ? [...addOns, change.moduleKey]
          : addOns.filter((key) => key !== change.moduleKey);
      proposed = effectiveModules(planKeys ?? [], nextAddOns);
    }
    return {
      current: sorted(current),
      proposed: sorted(proposed),
      gained: sorted([...proposed].filter((m) => !current.has(m))),
      lost: sorted([...current].filter((m) => !proposed.has(m))),
    };
  }

  async changePlan(
    tenantId: string,
    planVersionId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformSubscriptionChangeResponse> {
    try {
      return await runSerializable(this.prisma, async (tx) => {
        await this.findTenant(tx, tenantId);
        const version = await this.publishedVersion(tx, planVersionId);
        const existing = await tx.tenantSubscription.findUnique({
          where: { subscriberTenantId: tenantId },
        });
        if (existing?.planVersionId === version.id) {
          return {
            ...view(tenantId, await this.load(tx, tenantId)),
            changed: false,
          };
        }
        let subscriptionId: string;
        if (existing) {
          const updated = await tx.tenantSubscription.updateMany({
            where: { id: existing.id, planVersionId: existing.planVersionId },
            data: { planVersionId: version.id },
          });
          if (updated.count === 0) {
            return {
              ...view(tenantId, await this.load(tx, tenantId)),
              changed: false,
            };
          }
          subscriptionId = existing.id;
        } else {
          subscriptionId = (
            await tx.tenantSubscription.create({
              data: { subscriberTenantId: tenantId, planVersionId: version.id },
            })
          ).id;
        }
        await tx.tenantSubscriptionEvent.create({
          data: {
            subscriptionId,
            type: existing ? 'PLAN_CHANGED' : 'PLAN_ASSIGNED',
            fromPlanVersionId: existing?.planVersionId ?? null,
            toPlanVersionId: version.id,
            actorPlatformOperatorId: operator.id,
          },
        });
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.tenantSubscriptionChanged,
          operator,
          tenantId,
          requestReference,
        );
        return {
          ...view(tenantId, await this.load(tx, tenantId)),
          changed: true,
        };
      });
    } catch (error) {
      // Two first assignments racing: the loser sees the winner's state.
      if (isUniqueViolation(error)) {
        return { ...(await this.get(tenantId)), changed: false };
      }
      throw error;
    }
  }

  async grantAddOn(
    tenantId: string,
    moduleKey: OptionalModuleKey,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformSubscriptionChangeResponse> {
    try {
      return await runSerializable(this.prisma, async (tx) => {
        const subscription = await this.requireSubscription(tx, tenantId);
        if (subscription.planVersion.moduleKeys.includes(moduleKey)) {
          throw conflict(
            PLATFORM_ADDON_IN_PLAN,
            'That module is already in the plan.',
          );
        }
        if (subscription.moduleGrants.some((g) => g.moduleKey === moduleKey)) {
          return { ...view(tenantId, subscription), changed: false };
        }
        await tx.tenantModuleGrant.create({
          data: {
            subscriptionId: subscription.id,
            moduleKey,
            actorPlatformOperatorId: operator.id,
          },
        });
        await tx.tenantSubscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: 'ADDON_GRANTED',
            moduleKey,
            actorPlatformOperatorId: operator.id,
          },
        });
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.tenantAddonGranted,
          operator,
          tenantId,
          requestReference,
        );
        return {
          ...view(tenantId, await this.load(tx, tenantId)),
          changed: true,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { ...(await this.get(tenantId)), changed: false };
      }
      throw error;
    }
  }

  async revokeAddOn(
    tenantId: string,
    moduleKey: OptionalModuleKey,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformSubscriptionChangeResponse> {
    return runSerializable(this.prisma, async (tx) => {
      const subscription = await this.requireSubscription(tx, tenantId);
      const removed = await tx.tenantModuleGrant.deleteMany({
        where: { subscriptionId: subscription.id, moduleKey },
      });
      if (removed.count === 0) {
        return { ...view(tenantId, subscription), changed: false };
      }
      await tx.tenantSubscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: 'ADDON_REVOKED',
          moduleKey,
          actorPlatformOperatorId: operator.id,
        },
      });
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.tenantAddonRevoked,
        operator,
        tenantId,
        requestReference,
      );
      return {
        ...view(tenantId, await this.load(tx, tenantId)),
        changed: true,
      };
    });
  }

  private async findTenant(db: Db, tenantId: string): Promise<void> {
    if (!isUuid(tenantId)) throw new NotFoundException(NOT_FOUND);
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException(NOT_FOUND);
  }

  private load(db: Db, tenantId: string): Promise<SubscriptionRow | null> {
    return db.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
  }

  private async requireSubscription(tx: Tx, tenantId: string) {
    await this.findTenant(tx, tenantId);
    const row = await this.load(tx, tenantId);
    if (!row) {
      throw conflict(
        PLATFORM_NO_SUBSCRIPTION,
        'This business has no subscription. Assign a plan first.',
      );
    }
    return row;
  }

  // Only a PUBLISHED version can be assigned (a draft is unfinished; a
  // retired one is no longer offered).
  private async publishedVersion(db: Db, planVersionId: string) {
    if (!isUuid(planVersionId)) throw new NotFoundException(VERSION_NOT_FOUND);
    const version = await db.subscriptionPlanVersion.findUnique({
      where: { id: planVersionId },
      select: { id: true, status: true, moduleKeys: true },
    });
    if (!version) throw new NotFoundException(VERSION_NOT_FOUND);
    if (version.status !== 'PUBLISHED') {
      throw conflict(
        PLATFORM_PLAN_VERSION_NOT_PUBLISHED,
        'Only a published plan version can be assigned.',
      );
    }
    return version;
  }

  private async audit(
    tx: Tx,
    action: string,
    operator: PlatformOperatorRow,
    tenantId: string,
    requestReference: string | undefined,
  ): Promise<void> {
    await tx.platformAuditEvent.create({
      data: {
        action,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        targetType: 'tenant',
        targetId: tenantId,
        requestReference: requestReference ?? null,
      },
    });
  }
}
