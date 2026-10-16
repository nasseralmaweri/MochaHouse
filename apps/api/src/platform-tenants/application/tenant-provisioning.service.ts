import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  BUILT_IN_INTERNAL_ROLES,
  PLATFORM_ADMINISTRATOR_ROLE,
  PLATFORM_IDEMPOTENCY_KEY_REUSED,
  PLATFORM_TENANT_SLUG_TAKEN,
  PLATFORM_PLAN_VERSION_NOT_PUBLISHED,
  type PlatformTenantProvisionResponse,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { isDevInternalAuthEnabled } from '../../internal-auth/infrastructure/internal-auth-provider-mode';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import {
  provisionRequestHash,
  type NormalisedProvisionRequest,
} from './tenant-provision-request';

// SC1d — the ONE place platform code writes a business's own (tenant-owned)
// rows. Everywhere else the platform plane only reads business data; a test
// (platform-write-boundary.spec.ts) fails if any other platform file writes.
//
// One SERIALIZABLE transaction creates, or nothing is created:
//   1. the business (Tenant), ACTIVE — a registry status only: no location,
//      menu, ordering, payment, storefront routing or subscription comes
//      with it;
//   2. its built-in staff roles and their permissions (the shared
//      definitions Tenant #1 uses);
//   2b. (SC2a) its subscription to the chosen PUBLISHED plan version, with
//      its first history row;
//   3. its first owner: an ACTIVE staff member with NO login yet
//      (externalSubject null), holding the full administrator role at
//      corporate scope. Sign-in binds a login to it only for a VERIFIED
//      email equal to ownerEmail (ignoring case), inside this business only;
//   4. the provisioning record (idempotency) and the platform audit event.
//
// Idempotency (per operation, keyed by the Idempotency-Key):
//   - same key + same normalised request + same operator -> the original
//     result, nothing written;
//   - same key, anything else different -> 409 IDEMPOTENCY_KEY_REUSED;
//   - new key, slug already used -> 409 SLUG_TAKEN.
// Concurrency: the key and the slug are UNIQUE in the database. A racing
// duplicate fails its transaction (unique violation or serialization
// failure) and is then answered from what the winner committed.

type Outcome =
  | { kind: 'created' | 'replayed'; tenantId: string }
  | { kind: 'key-reused' }
  | { kind: 'slug-taken' }
  | { kind: 'plan-unavailable' };

const SLUG_TAKEN_MESSAGE = 'Another business already uses that slug.';
const KEY_REUSED_MESSAGE =
  'This provisioning request was already used for a different business. Start a new request.';

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

// Structural (the error can surface through another module identity).
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

@Injectable()
export class TenantProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async provision(
    request: NormalisedProvisionRequest,
    idempotencyKey: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformTenantProvisionResponse> {
    const requestHash = provisionRequestHash(request);
    let outcome: Outcome;
    try {
      outcome = await runSerializable(this.prisma, (tx) =>
        this.provisionIn(
          tx,
          request,
          idempotencyKey,
          requestHash,
          operator,
          requestReference,
        ),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost a race: answer from what the winning transaction committed.
      const recovered = await this.prisma.$transaction((tx) =>
        this.existingOutcome(
          tx,
          request,
          idempotencyKey,
          requestHash,
          operator,
        ),
      );
      if (recovered === null) throw error;
      outcome = recovered;
    }

    switch (outcome.kind) {
      case 'key-reused':
        throw conflict(PLATFORM_IDEMPOTENCY_KEY_REUSED, KEY_REUSED_MESSAGE);
      case 'slug-taken':
        throw conflict(PLATFORM_TENANT_SLUG_TAKEN, SLUG_TAKEN_MESSAGE);
      case 'plan-unavailable':
        throw conflict(
          PLATFORM_PLAN_VERSION_NOT_PUBLISHED,
          'That plan is not available. Choose a published plan.',
        );
      default:
        return this.result(outcome.tenantId, outcome.kind === 'replayed');
    }
  }

  private async provisionIn(
    tx: Prisma.TransactionClient,
    request: NormalisedProvisionRequest,
    idempotencyKey: string,
    requestHash: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<Outcome> {
    const existing = await this.existingOutcome(
      tx,
      request,
      idempotencyKey,
      requestHash,
      operator,
    );
    if (existing) return existing;

    // SC2a — the business starts on a PUBLISHED plan version.
    const planVersion = await tx.subscriptionPlanVersion.findUnique({
      where: { id: request.planVersionId },
      select: { id: true, status: true },
    });
    if (!planVersion || planVersion.status !== 'PUBLISHED') {
      return { kind: 'plan-unavailable' };
    }

    const tenant = await tx.tenant.create({
      data: { slug: request.slug, name: request.name, status: 'ACTIVE' },
    });

    let administratorRoleId: string | null = null;
    for (const definition of BUILT_IN_INTERNAL_ROLES) {
      const role = await tx.internalRole.create({
        data: {
          tenantId: tenant.id,
          key: definition.key,
          displayName: definition.displayName,
          description: definition.description,
          isSystem: true,
        },
      });
      await tx.internalRolePermission.createMany({
        data: definition.permissionKeys.map((permissionKey) => ({
          tenantId: tenant.id,
          roleId: role.id,
          permissionKey,
        })),
      });
      if (definition.key === PLATFORM_ADMINISTRATOR_ROLE.key) {
        administratorRoleId = role.id;
      }
    }
    if (administratorRoleId === null) {
      throw new Error('The built-in administrator role is not defined.');
    }

    const owner = await tx.internalUser.create({
      data: {
        tenantId: tenant.id,
        // The marker staff sign-in will present: the dev provider only where
        // dev staff auth is enabled (never in production).
        externalProvider: isDevInternalAuthEnabled()
          ? 'internal-dev'
          : 'cognito-internal',
        externalSubject: null,
        email: request.ownerEmail,
        displayName: request.ownerDisplayName,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await tx.internalUserRoleAssignment.create({
      data: {
        tenantId: tenant.id,
        internalUserId: owner.id,
        roleId: administratorRoleId,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    const subscription = await tx.tenantSubscription.create({
      data: { subscriberTenantId: tenant.id, planVersionId: planVersion.id },
    });
    await tx.tenantSubscriptionEvent.create({
      data: {
        subscriptionId: subscription.id,
        type: 'PLAN_ASSIGNED',
        toPlanVersionId: planVersion.id,
        actorPlatformOperatorId: operator.id,
      },
    });

    await tx.tenantProvisioningOperation.create({
      data: {
        idempotencyKey,
        requestHash,
        provisionedTenantId: tenant.id,
        actorPlatformOperatorId: operator.id,
      },
    });
    await tx.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.tenantProvisioned,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        targetType: 'tenant',
        targetId: tenant.id,
        requestReference: requestReference ?? null,
      },
    });

    return { kind: 'created', tenantId: tenant.id };
  }

  // What an already-used key or slug means for this request (null: neither
  // is used yet).
  private async existingOutcome(
    tx: Prisma.TransactionClient,
    request: NormalisedProvisionRequest,
    idempotencyKey: string,
    requestHash: string,
    operator: PlatformOperatorRow,
  ): Promise<Outcome | null> {
    const operation = await tx.tenantProvisioningOperation.findUnique({
      where: { idempotencyKey },
    });
    if (operation) {
      return operation.requestHash === requestHash &&
        operation.actorPlatformOperatorId === operator.id
        ? { kind: 'replayed', tenantId: operation.provisionedTenantId }
        : { kind: 'key-reused' };
    }
    const slugTaken = await tx.tenant.findUnique({
      where: { slug: request.slug },
      select: { id: true },
    });
    return slugTaken ? { kind: 'slug-taken' } : null;
  }

  private async result(
    tenantId: string,
    replayed: boolean,
  ): Promise<PlatformTenantProvisionResponse> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        createdAt: true,
      },
    });
    const owner = await this.prisma.internalUser.findFirst({
      where: {
        tenantId,
        roleAssignments: {
          some: {
            scopeType: 'CORPORATE',
            role: { key: PLATFORM_ADMINISTRATOR_ROLE.key },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      select: { email: true, displayName: true },
    });
    if (!tenant || !owner) {
      // A provisioning record without its business is impossible by
      // construction (one transaction); never answer with partial data.
      throw new InternalServerErrorException(
        'Provisioning result is unavailable.',
      );
    }
    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        createdAt: tenant.createdAt.toISOString(),
      },
      owner: { email: owner.email, displayName: owner.displayName },
      replayed,
    };
  }
}
