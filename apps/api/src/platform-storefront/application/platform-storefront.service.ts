import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  STOREFRONT_ASSIGNMENT_UNAVAILABLE,
  STOREFRONT_HOST_TAKEN,
  STOREFRONT_HOST_UNCHANGED,
  STOREFRONT_NOT_ELIGIBLE,
  STOREFRONT_PUBLISHING_CHECKS,
  STOREFRONT_SLUG_MISMATCH,
  normalizeStorefrontHost,
  platformStorefrontHost,
  type PlatformStorefrontView,
  type StorefrontHostAction,
  type StorefrontHostKind,
  type StorefrontPublishingCheck,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import {
  READINESS_LOCATION_SELECT,
  billingAuthorized,
  locationsReadiness,
} from '../../locations/application/location-readiness';
import {
  STOREFRONT_ROUTING_CONFIG,
  type StorefrontRoutingConfig,
} from '../../tenancy/storefront-context';
import {
  STOREFRONT_PUBLISHING_CONFIG,
  type StorefrontPublishingConfig,
} from './storefront-publishing-config';
import type {
  StorefrontAssignInput,
  StorefrontChangeInput,
} from './storefront-publishing-query';

type Db = Prisma.TransactionClient | PrismaService;

const HISTORY_LIMIT = 50;

// SC4f-3a (owner decisions H1–H3) — storefront publishing by platform
// operators. Every write:
//   * is made by an operator holding storefront.manage, with a recent sign-in
//     (checked by the controller), a written reason, and the business's slug
//     typed to confirm it is the intended business;
//   * runs in one transaction with its append-only history row and its
//     platform audit event;
//   * never moves an address to another business (the registry's database
//     guard refuses it) and never publishes anything automatically.
// Publishing marks a registry row; the storefront is publicly live only
// while the deployment's host routing switch is also on.
@Injectable()
export class PlatformStorefrontService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STOREFRONT_PUBLISHING_CONFIG)
    private readonly config: StorefrontPublishingConfig,
    @Inject(STOREFRONT_ROUTING_CONFIG)
    private readonly routing: StorefrontRoutingConfig,
  ) {}

  async view(tenantId: string): Promise<PlatformStorefrontView> {
    const tenant = await this.requireTenant(this.prisma, tenantId);
    const [hosts, eligibility, history] = await Promise.all([
      this.prisma.storefrontHost.findMany({
        where: { storefrontTenantId: tenantId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          hostname: true,
          kind: true,
          published: true,
          publishedAt: true,
          createdAt: true,
        },
      }),
      publishingEligibility(this.prisma, tenant),
      this.prisma.storefrontHostChange.findMany({
        where: { storefrontHost: { storefrontTenantId: tenantId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: HISTORY_LIMIT,
        select: {
          id: true,
          action: true,
          reason: true,
          createdAt: true,
          storefrontHost: { select: { hostname: true } },
          actorPlatformOperator: { select: { email: true } },
        },
      }),
    ]);

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
      },
      hostRouting: this.routing.hostRouting,
      hosts: hosts.map((host) => ({
        id: host.id,
        hostname: host.hostname,
        kind: host.kind as StorefrontHostKind,
        published: host.published,
        publishedAt: host.publishedAt?.toISOString() ?? null,
        live: host.published && this.routing.hostRouting,
        createdAt: host.createdAt.toISOString(),
      })),
      eligibility,
      assignable: await this.assignable(tenant, hosts),
      history: history.map((row) => ({
        id: row.id,
        action: row.action as StorefrontHostAction,
        hostname: row.storefrontHost.hostname,
        reason: row.reason,
        actorEmail: row.actorPlatformOperator.email,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async assign(
    tenantId: string,
    input: StorefrontAssignInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformStorefrontView> {
    const tenant = await this.requireTenant(this.prisma, tenantId);
    assertSlug(tenant, input.confirmSlug);
    const hostname =
      input.kind === 'PLATFORM_SUBDOMAIN'
        ? await this.platformHostnameFor(tenant)
        : this.legacyHostnameFor(tenant, input.hostname);

    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.storefrontHost.findUnique({
          where: { hostname },
          select: { storefrontTenantId: true },
        });
        if (existing) throw hostTaken(existing.storefrontTenantId === tenantId);
        const host = await tx.storefrontHost.create({
          data: {
            hostname,
            storefrontTenantId: tenantId,
            kind: input.kind,
          },
          select: { id: true },
        });
        await recordChange(
          tx,
          host.id,
          'ASSIGNED',
          input.reason,
          operator,
          requestReference,
        );
      });
    } catch (error) {
      // Lost a race for the same address: the database's unique key decided.
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        const winner = await this.prisma.storefrontHost.findUnique({
          where: { hostname },
          select: { storefrontTenantId: true },
        });
        throw hostTaken(winner?.storefrontTenantId === tenantId);
      }
      throw error;
    }
    return this.view(tenantId);
  }

  publish(
    tenantId: string,
    hostId: string,
    input: StorefrontChangeInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformStorefrontView> {
    return this.change(
      tenantId,
      hostId,
      true,
      input,
      operator,
      requestReference,
    );
  }

  unpublish(
    tenantId: string,
    hostId: string,
    input: StorefrontChangeInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformStorefrontView> {
    return this.change(
      tenantId,
      hostId,
      false,
      input,
      operator,
      requestReference,
    );
  }

  // Publish or unpublish one address of THIS business. The address row is
  // locked for the transaction, so concurrent changes to it are applied one
  // at a time and the second sees the first's result.
  private async change(
    tenantId: string,
    hostId: string,
    publish: boolean,
    input: StorefrontChangeInput,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformStorefrontView> {
    await this.prisma.$transaction(async (tx) => {
      const tenant = await this.requireTenant(tx, tenantId);
      assertSlug(tenant, input.confirmSlug);
      const locked = await tx.$queryRaw<
        Array<{ storefrontTenantId: string; published: boolean }>
      >`SELECT "storefrontTenantId", "published" FROM "StorefrontHost" WHERE "id" = ${hostId} FOR UPDATE`;
      const host = locked[0];
      // Another business's address reads exactly like a missing one.
      if (!host || host.storefrontTenantId !== tenantId) {
        throw new NotFoundException('Storefront address not found.');
      }
      if (host.published === publish) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: STOREFRONT_HOST_UNCHANGED,
          message: publish
            ? 'This address is already published.'
            : 'This address is not published.',
        });
      }
      if (publish) {
        // Hold the business and its subscription steady while the checks
        // run: a concurrent suspension or billing change either commits
        // first (and is seen here) or waits for this publish.
        await tx.$queryRaw`SELECT 1 AS held FROM "Tenant" WHERE "id" = ${tenantId} FOR SHARE`;
        await tx.$queryRaw`SELECT 1 AS held FROM "TenantSubscription" WHERE "subscriberTenantId" = ${tenantId} FOR SHARE`;
        const current = await this.requireTenant(tx, tenantId);
        const eligibility = await publishingEligibility(tx, current);
        if (!eligibility.eligible) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: STOREFRONT_NOT_ELIGIBLE,
            message: 'This business is not ready to publish its storefront.',
            missing: eligibility.checks
              .filter((check) => !check.passed)
              .map((check) => check.key),
          });
        }
      }
      await tx.storefrontHost.update({
        where: { id: hostId },
        data: { published: publish, publishedAt: publish ? new Date() : null },
      });
      await recordChange(
        tx,
        hostId,
        publish ? 'PUBLISHED' : 'UNPUBLISHED',
        input.reason,
        operator,
        requestReference,
      );
    });
    return this.view(tenantId);
  }

  private async requireTenant(db: Db, tenantId: string) {
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!tenant) throw new NotFoundException('Business not found.');
    return tenant;
  }

  // The business's platform address, when it may be assigned now.
  private async platformHostnameFor(tenant: { id: string; slug: string }) {
    const { hostname, unavailable } = this.platformCandidate(tenant);
    if (!hostname)
      throw assignmentUnavailable(UNAVAILABLE_MESSAGE[unavailable!]);
    // One platform address per business (owner decision F1).
    const own = await this.prisma.storefrontHost.findFirst({
      where: { storefrontTenantId: tenant.id, kind: 'PLATFORM_SUBDOMAIN' },
      select: { id: true },
    });
    if (own) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: STOREFRONT_HOST_UNCHANGED,
        message: 'This business already has its platform address.',
      });
    }
    return hostname;
  }

  private platformCandidate(tenant: { slug: string }): {
    hostname: string | null;
    unavailable: keyof typeof UNAVAILABLE_MESSAGE | null;
  } {
    if (!this.config.storefrontDomain) {
      return { hostname: null, unavailable: 'domain_not_configured' };
    }
    const hostname = platformStorefrontHost(
      tenant.slug,
      this.config.storefrontDomain,
    );
    if (!hostname) return { hostname: null, unavailable: 'slug_not_usable' };
    // A platform address can never take one of Mocha House's approved
    // existing addresses.
    if (this.config.legacyHostnames.includes(hostname)) {
      return { hostname: null, unavailable: 'reserved_for_legacy' };
    }
    return { hostname, unavailable: null };
  }

  // An approved existing address, for Mocha House only.
  private legacyHostnameFor(
    tenant: { id: string },
    requested: string | null,
  ): string {
    // The business legacy addresses belong to comes from trusted
    // configuration (LEGACY_STOREFRONT_TENANT_ID), never from a request.
    if (
      this.config.legacyTenantId === null ||
      tenant.id !== this.config.legacyTenantId
    ) {
      throw assignmentUnavailable(
        'Existing addresses can be registered only for Mocha House.',
      );
    }
    const hostname = normalizeStorefrontHost(requested);
    if (!hostname || !this.config.legacyHostnames.includes(hostname)) {
      throw assignmentUnavailable(
        'That address is not one of the approved existing addresses.',
      );
    }
    return hostname;
  }

  private async assignable(
    tenant: { id: string; slug: string },
    hosts: ReadonlyArray<{ hostname: string; kind: string }>,
  ): Promise<PlatformStorefrontView['assignable']> {
    let { hostname: platformHostname, unavailable } =
      this.platformCandidate(tenant);
    if (hosts.some((host) => host.kind === 'PLATFORM_SUBDOMAIN')) {
      platformHostname = null;
      unavailable = 'already_assigned';
    } else if (platformHostname) {
      const taken = await this.prisma.storefrontHost.findUnique({
        where: { hostname: platformHostname },
        select: { id: true },
      });
      if (taken) {
        platformHostname = null;
        unavailable = 'taken';
      }
    }
    let legacyHostnames: string[] = [];
    if (tenant.id === this.config.legacyTenantId) {
      const assigned = await this.prisma.storefrontHost.findMany({
        where: { hostname: { in: [...this.config.legacyHostnames] } },
        select: { hostname: true },
      });
      const taken = new Set(assigned.map((row) => row.hostname));
      legacyHostnames = this.config.legacyHostnames.filter(
        (hostname) => !taken.has(hostname),
      );
    }
    return {
      platformHostname,
      platformUnavailable: unavailable,
      legacyHostnames,
    };
  }
}

const PUBLISHABLE_SUBSCRIPTION_STATUSES: readonly string[] = [
  'ACTIVE',
  'TRIALING',
];

const UNAVAILABLE_MESSAGE = {
  domain_not_configured:
    'Platform addresses are not configured for this deployment.',
  slug_not_usable:
    "This business's slug cannot be used as a storefront address.",
  reserved_for_legacy:
    "This business's platform address is reserved for an existing Mocha House address.",
  already_assigned: 'This business already has its platform address.',
  taken: 'This address is already assigned.',
} as const;

// SC4f-3a (owner decision H2) — whether a business may publish its
// storefront, computed from real data: active; billing or trial verified —
// an ACTIVE or TRIALING subscription that has passed the SC4d authorization
// rule (fail closed: a business with no subscription is not authorized);
// and at least one active location that is set up (profile and opening
// hours) with an assigned menu offering a product a customer could buy.
// Digital ordering does NOT need to be on — a published storefront may be
// browse-only. Shares SC4d's readiness implementation, so the console, the
// owner's checklist and ordering can never disagree.
export async function publishingEligibility(
  db: Db,
  tenant: { id: string; status: string },
): Promise<PlatformStorefrontView['eligibility']> {
  const [billing, subscription, locations] = await Promise.all([
    billingAuthorized(db, [tenant.id]),
    db.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenant.id },
      select: { status: true },
    }),
    db.location.findMany({
      where: { tenantId: tenant.id, isActive: true },
      select: READINESS_LOCATION_SELECT,
    }),
  ]);
  const readiness = [
    ...(
      await locationsReadiness(
        db,
        locations.map((location) => ({ ...location, tenantId: tenant.id })),
      )
    ).values(),
  ];
  const passed: Record<StorefrontPublishingCheck, boolean> = {
    business_active: tenant.status === 'ACTIVE',
    billing_authorized:
      billing.get(tenant.id) === true &&
      subscription !== null &&
      PUBLISHABLE_SUBSCRIPTION_STATUSES.includes(subscription.status),
    location_configured: readiness.some((r) => r.profile && r.hours),
    menu_available: readiness.some((r) => r.profile && r.hours && r.menu),
  };
  const checks = STOREFRONT_PUBLISHING_CHECKS.map((key) => ({
    key,
    passed: passed[key],
  }));
  return { eligible: checks.every((check) => check.passed), checks };
}

function assertSlug(tenant: { slug: string }, confirmSlug: string): void {
  if (confirmSlug !== tenant.slug) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: STOREFRONT_SLUG_MISMATCH,
      message: "The slug you typed does not match this business's slug.",
    });
  }
}

function hostTaken(sameBusiness: boolean): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: STOREFRONT_HOST_TAKEN,
    message: sameBusiness
      ? 'This address is already assigned to this business.'
      : 'This address is already assigned.',
  });
}

function assignmentUnavailable(message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: STOREFRONT_ASSIGNMENT_UNAVAILABLE,
    message,
  });
}

async function recordChange(
  tx: Prisma.TransactionClient,
  storefrontHostId: string,
  action: StorefrontHostAction,
  reason: string,
  operator: PlatformOperatorRow,
  requestReference: string | undefined,
): Promise<void> {
  await tx.storefrontHostChange.create({
    data: {
      storefrontHostId,
      action,
      reason,
      actorPlatformOperatorId: operator.id,
    },
  });
  await tx.platformAuditEvent.create({
    data: {
      action: AUDIT_ACTION[action],
      outcome: 'SUCCEEDED',
      actorPlatformOperatorId: operator.id,
      targetType: 'storefront_host',
      targetId: storefrontHostId,
      requestReference: requestReference ?? null,
    },
  });
}

const AUDIT_ACTION: Record<StorefrontHostAction, string> = {
  ASSIGNED: PLATFORM_AUDIT_ACTIONS.storefrontHostAssigned,
  PUBLISHED: PLATFORM_AUDIT_ACTIONS.storefrontPublished,
  UNPUBLISHED: PLATFORM_AUDIT_ACTIONS.storefrontUnpublished,
};
