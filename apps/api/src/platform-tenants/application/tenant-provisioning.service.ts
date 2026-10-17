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
  slugCandidate,
  type NormalisedProvisionRequest,
} from './tenant-provision-request';

// SC4b — what the owner's onboarding asks for. The registration and login
// come from the owner's VERIFIED session (never the request body); the plan
// version, price and expected price from the owner's choice.
export interface OwnerProvisionRequest {
  registrationId: string;
  identityProvider: string;
  identitySubject: string;
  businessName: string;
  planVersionId: string;
  planPriceId: string;
  expectedPrice: {
    interval: 'MONTH' | 'YEAR';
    currency: string;
    amountMinorUnits: number;
  };
}

export type OwnerProvisionOutcome =
  | {
      kind: 'created' | 'replayed';
      business: { id: string; name: string; slug: string };
    }
  | { kind: 'not-eligible' }
  | { kind: 'plan-unavailable' }
  | { kind: 'price-changed' };

// Another request linked this registration to its business first.
class OwnerAlreadyProvisioned extends Error {}

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

    const administratorRoleId = await this.createBuiltInRoles(tx, tenant.id);

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

  // The built-in staff roles and their permissions (the shared definitions
  // Tenant #1 uses). Returns the administrator role's id.
  private async createBuiltInRoles(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    let administratorRoleId: string | null = null;
    for (const definition of BUILT_IN_INTERNAL_ROLES) {
      const role = await tx.internalRole.create({
        data: {
          tenantId,
          key: definition.key,
          displayName: definition.displayName,
          description: definition.description,
          isSystem: true,
        },
      });
      await tx.internalRolePermission.createMany({
        data: definition.permissionKeys.map((permissionKey) => ({
          tenantId,
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
    return administratorRoleId;
  }

  // --- SC4b: a business created by its OWNER (self-service) ---------------
  //
  // The same ONE writer of a business's own rows, for an owner instead of an
  // operator (owner decisions B1–B4). Never impersonates an operator: no
  // operator is recorded anywhere; history is source OWNER and the audit
  // event names the owner's login (identity fields), not an operator.
  //
  // One SERIALIZABLE transaction creates, or nothing is created:
  //   1. the business (ACTIVE registry entry, an automatic unique slug);
  //   2. its built-in roles;
  //   3. its first owner, bound to the owner's OWN verified login by subject
  //      (never matched by email), administrator at corporate scope;
  //   4. its subscription: BILLED at the exact plan version and price the
  //      owner chose, PAYMENT SETUP PENDING (nothing at the provider,
  //      nothing authorized or charged), with its history;
  //   5. its billing contact (the owner);
  //   6. the registration's immutable link to the business (one business
  //      per verified owner: unique, never changes) and the audit event.
  // A retry — or a concurrent request — for the same registration returns
  // the business already created; it never creates a second one.
  async provisionForOwner(
    request: OwnerProvisionRequest,
    requestReference: string | undefined,
  ): Promise<OwnerProvisionOutcome> {
    const attempt = () =>
      runSerializable(this.prisma, (tx) =>
        this.provisionForOwnerIn(tx, request, requestReference),
      );
    // A concurrent request for this owner won, or (very rarely) a slug
    // collided: decide again from what is committed now (a few times).
    for (let tries = 1; ; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        const retriable =
          isUniqueViolation(error) || error instanceof OwnerAlreadyProvisioned;
        if (!retriable || tries >= 3) throw error;
      }
    }
  }

  private async provisionForOwnerIn(
    tx: Prisma.TransactionClient,
    request: OwnerProvisionRequest,
    requestReference: string | undefined,
  ): Promise<OwnerProvisionOutcome> {
    const registration = await tx.ownerRegistration.findUnique({
      where: { id: request.registrationId },
    });
    if (
      !registration ||
      registration.status !== 'VERIFIED' ||
      registration.identitySubject === null ||
      registration.identityProvider !== request.identityProvider ||
      registration.identitySubject !== request.identitySubject ||
      registration.displayName === null
    ) {
      return { kind: 'not-eligible' };
    }
    if (registration.provisionedTenantId !== null) {
      return this.ownerOutcome(tx, registration.provisionedTenantId, true);
    }

    // The exact version offered: the plan's newest PUBLISHED version, of a
    // plan offered for self-service (never Founding).
    const version = await tx.subscriptionPlanVersion.findUnique({
      where: { id: request.planVersionId },
      include: { plan: true },
    });
    if (
      !version ||
      version.status !== 'PUBLISHED' ||
      !version.plan.selfServiceAvailable ||
      version.plan.key === 'founding'
    ) {
      return { kind: 'plan-unavailable' };
    }
    const newest = await tx.subscriptionPlanVersion.findFirst({
      where: { planId: version.planId, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (newest?.id !== version.id) return { kind: 'plan-unavailable' };
    const price = await tx.subscriptionPlanPrice.findUnique({
      where: { id: request.planPriceId },
    });
    if (
      !price ||
      price.planId !== version.planId ||
      price.status !== 'ACTIVE'
    ) {
      return { kind: 'plan-unavailable' };
    }
    // Never a different price than the one the owner saw.
    if (
      price.interval !== request.expectedPrice.interval ||
      price.currency !== request.expectedPrice.currency ||
      price.amountMinorUnits !== request.expectedPrice.amountMinorUnits
    ) {
      return { kind: 'price-changed' };
    }

    const slug = await this.freeSlug(tx, request.businessName);
    const tenant = await tx.tenant.create({
      data: { slug, name: request.businessName, status: 'ACTIVE' },
    });
    const administratorRoleId = await this.createBuiltInRoles(tx, tenant.id);

    const now = new Date();
    const owner = await tx.internalUser.create({
      data: {
        tenantId: tenant.id,
        // The owner's own verified login, bound by subject from the start.
        externalProvider: registration.identityProvider,
        externalSubject: registration.identitySubject,
        email: registration.email,
        displayName: registration.displayName,
        status: 'ACTIVE',
        activatedAt: now,
        verifiedEmail: registration.email,
        emailVerifiedAt: registration.verifiedAt,
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
      data: {
        subscriberTenantId: tenant.id,
        planVersionId: version.id,
        billingMode: 'BILLED',
        planPriceId: price.id,
        status: 'ACTIVE',
        // SC3e-4 — payment setup is needed from now (a deadline only with
        // billing enforcement on).
        paymentSetupRequiredSince: now,
      },
    });
    await tx.tenantSubscriptionEvent.createMany({
      data: [
        {
          subscriptionId: subscription.id,
          type: 'PLAN_ASSIGNED',
          toPlanVersionId: version.id,
          planPriceId: price.id,
          source: 'OWNER',
        },
        {
          subscriptionId: subscription.id,
          type: 'PAYMENT_SETUP_REQUIRED',
          fromStatus: 'ACTIVE',
          toStatus: 'ACTIVE',
          planPriceId: price.id,
          source: 'OWNER',
        },
      ],
    });
    await tx.tenantBillingContact.create({
      data: { tenantId: tenant.id, internalUserId: owner.id },
    });

    // The ONE business of this registration (unique, immutable). Losing a
    // race here means another request created it: this one rolls back.
    const linked = await tx.ownerRegistration.updateMany({
      where: {
        id: registration.id,
        status: 'VERIFIED',
        provisionedTenantId: null,
      },
      data: { provisionedTenantId: tenant.id, provisionedAt: now },
    });
    if (linked.count !== 1) throw new OwnerAlreadyProvisioned();
    await tx.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.tenantSelfProvisioned,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: null,
        identityProvider: registration.identityProvider,
        identitySubject: registration.identitySubject,
        targetType: 'tenant',
        targetId: tenant.id,
        requestReference: requestReference ?? null,
      },
    });
    return {
      kind: 'created',
      business: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
  }

  // An automatic, unique slug (owner decision D7): never shown or chosen
  // before storefront routing exists.
  private async freeSlug(
    tx: Prisma.TransactionClient,
    businessName: string,
  ): Promise<string> {
    for (let i = 0; i < 5; i += 1) {
      const candidate = slugCandidate(businessName);
      const taken = await tx.tenant.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    throw new InternalServerErrorException('No free business key was found.');
  }

  private async ownerOutcome(
    tx: Prisma.TransactionClient,
    tenantId: string,
    replayed: boolean,
  ): Promise<OwnerProvisionOutcome> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true },
    });
    return { kind: replayed ? 'replayed' : 'created', business: tenant };
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
