import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PLATFORM_PLAN_DRAFT_EXISTS,
  PLATFORM_PLAN_KEY_TAKEN,
  PLATFORM_PLAN_NOT_SELF_SERVICE,
  PLATFORM_PLAN_VERSION_NOT_DRAFT,
  PLATFORM_PLAN_VERSION_NOT_PUBLISHED,
  isOptionalModuleKey,
  type OptionalModuleKey,
  type PlatformPlan,
  type PlatformPlanListResponse,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { isUuid, type PlanCreateInput } from './plan-input';

// SC2a — CENTERIVO SaaS plans (platform data). A plan has numbered
// versions: a DRAFT can be edited; PUBLISHING freezes it (the database
// refuses any later change to its modules) and makes it assignable;
// RETIRING stops offering it while businesses already on it keep it.
// At most one DRAFT per plan at a time. Every change is audited with the
// plan as target, in the same transaction.

const NOT_FOUND = 'Plan not found.';

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

export const PLAN_INCLUDE = {
  versions: {
    orderBy: { version: 'desc' },
    include: { _count: { select: { subscriptions: true } } },
  },
  // SC3a — list prices, newest first.
  prices: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { _count: { select: { subscriptions: true } } },
  },
} as const satisfies Prisma.SubscriptionPlanInclude;

type PlanRow = Prisma.SubscriptionPlanGetPayload<{
  include: typeof PLAN_INCLUDE;
}>;

export function toPlan(row: PlanRow): PlatformPlan {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    selfServiceAvailable: row.selfServiceAvailable,
    versions: row.versions.map((version) => ({
      id: version.id,
      version: version.version,
      status: version.status,
      moduleKeys: version.moduleKeys.filter((key): key is OptionalModuleKey =>
        isOptionalModuleKey(key),
      ),
      publishedAt: version.publishedAt?.toISOString() ?? null,
      retiredAt: version.retiredAt?.toISOString() ?? null,
      subscriberCount: version._count.subscriptions,
    })),
    prices: row.prices.map((price) => ({
      id: price.id,
      interval: price.interval,
      currency: price.currency,
      amountMinorUnits: price.amountMinorUnits,
      status: price.status,
      createdAt: price.createdAt.toISOString(),
      archivedAt: price.archivedAt?.toISOString() ?? null,
      subscriberCount: price._count.subscriptions,
    })),
  };
}

@Injectable()
export class SubscriptionPlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<PlatformPlanListResponse> {
    const [plans, total] = await Promise.all([
      this.prisma.subscriptionPlan.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: PLAN_INCLUDE,
      }),
      this.prisma.tenantSubscription.count(),
    ]);
    return { plans: plans.map(toPlan), subscriptions: { total } };
  }

  async create(
    input: PlanCreateInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    try {
      return await runSerializable(this.prisma, async (tx) => {
        const plan = await tx.subscriptionPlan.create({
          data: {
            key: input.key,
            name: input.name,
            description: input.description,
            versions: {
              create: { version: 1, moduleKeys: input.moduleKeys },
            },
          },
        });
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.planCreated,
          operator,
          plan.id,
          requestReference,
        );
        return toPlan(await this.load(tx, plan.id));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          PLATFORM_PLAN_KEY_TAKEN,
          'Another plan already uses that key.',
        );
      }
      throw error;
    }
  }

  async createVersion(
    planId: string,
    moduleKeys: OptionalModuleKey[],
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    try {
      return await runSerializable(this.prisma, async (tx) => {
        const plan = await this.load(tx, planId);
        if (plan.versions.some((v) => v.status === 'DRAFT')) {
          throw conflict(
            PLATFORM_PLAN_DRAFT_EXISTS,
            'This plan already has a draft version. Publish or edit it first.',
          );
        }
        const next = (plan.versions[0]?.version ?? 0) + 1;
        await tx.subscriptionPlanVersion.create({
          data: { planId: plan.id, version: next, moduleKeys },
        });
        await this.audit(
          tx,
          PLATFORM_AUDIT_ACTIONS.planVersionCreated,
          operator,
          plan.id,
          requestReference,
        );
        return toPlan(await this.load(tx, plan.id));
      });
    } catch (error) {
      // Two drafts racing for the same version number.
      if (isUniqueViolation(error)) {
        throw conflict(
          PLATFORM_PLAN_DRAFT_EXISTS,
          'This plan already has a draft version. Publish or edit it first.',
        );
      }
      throw error;
    }
  }

  async updateDraft(
    planId: string,
    versionId: string,
    moduleKeys: OptionalModuleKey[],
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    return runSerializable(this.prisma, async (tx) => {
      const version = await this.version(tx, planId, versionId);
      const updated = await tx.subscriptionPlanVersion.updateMany({
        where: { id: version.id, status: 'DRAFT' },
        data: { moduleKeys },
      });
      if (updated.count === 0) {
        throw conflict(
          PLATFORM_PLAN_VERSION_NOT_DRAFT,
          'Only a draft version can be edited. Create a new version instead.',
        );
      }
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.planVersionUpdated,
        operator,
        planId,
        requestReference,
      );
      return toPlan(await this.load(tx, planId));
    });
  }

  async publish(
    planId: string,
    versionId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    return runSerializable(this.prisma, async (tx) => {
      const version = await this.version(tx, planId, versionId);
      const updated = await tx.subscriptionPlanVersion.updateMany({
        where: { id: version.id, status: 'DRAFT' },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      if (updated.count === 0) {
        throw conflict(
          PLATFORM_PLAN_VERSION_NOT_DRAFT,
          'Only a draft version can be published.',
        );
      }
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.planVersionPublished,
        operator,
        planId,
        requestReference,
      );
      return toPlan(await this.load(tx, planId));
    });
  }

  async retire(
    planId: string,
    versionId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    return runSerializable(this.prisma, async (tx) => {
      const version = await this.version(tx, planId, versionId);
      const updated = await tx.subscriptionPlanVersion.updateMany({
        where: { id: version.id, status: 'PUBLISHED' },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      if (updated.count === 0) {
        throw conflict(
          PLATFORM_PLAN_VERSION_NOT_PUBLISHED,
          'Only a published version can be retired.',
        );
      }
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.planVersionRetired,
        operator,
        planId,
        requestReference,
      );
      return toPlan(await this.load(tx, planId));
    });
  }

  // SC4b — offer (or stop offering) the plan to owners creating a business
  // themselves (D3). Never the Founding plan (also a database CHECK).
  // Businesses already on the plan are unaffected either way.
  async setSelfService(
    planId: string,
    available: boolean,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPlan> {
    return runSerializable(this.prisma, async (tx) => {
      const plan = await this.load(tx, planId);
      if (available && plan.key === 'founding') {
        throw conflict(
          PLATFORM_PLAN_NOT_SELF_SERVICE,
          'The Founding plan cannot be offered to new businesses.',
        );
      }
      if (plan.selfServiceAvailable === available) return toPlan(plan);
      await tx.subscriptionPlan.update({
        where: { id: plan.id },
        data: { selfServiceAvailable: available },
      });
      await this.audit(
        tx,
        PLATFORM_AUDIT_ACTIONS.planSelfServiceChanged,
        operator,
        plan.id,
        requestReference,
      );
      return toPlan(await this.load(tx, plan.id));
    });
  }

  private async load(tx: Tx, planId: string): Promise<PlanRow> {
    if (!isUuid(planId)) throw new NotFoundException(NOT_FOUND);
    const plan = await tx.subscriptionPlan.findUnique({
      where: { id: planId },
      include: PLAN_INCLUDE,
    });
    if (!plan) throw new NotFoundException(NOT_FOUND);
    return plan;
  }

  private async version(tx: Tx, planId: string, versionId: string) {
    if (!isUuid(planId) || !isUuid(versionId)) {
      throw new NotFoundException(NOT_FOUND);
    }
    const version = await tx.subscriptionPlanVersion.findFirst({
      where: { id: versionId, planId },
      select: { id: true, status: true },
    });
    if (!version) throw new NotFoundException(NOT_FOUND);
    return version;
  }

  private async audit(
    tx: Tx,
    action: string,
    operator: PlatformOperatorRow,
    planId: string,
    requestReference: string | undefined,
  ): Promise<void> {
    await tx.platformAuditEvent.create({
      data: {
        action,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        targetType: 'plan',
        targetId: planId,
        requestReference: requestReference ?? null,
      },
    });
  }
}
