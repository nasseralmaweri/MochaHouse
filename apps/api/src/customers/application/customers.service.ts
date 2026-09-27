import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type {
  CustomerProfile,
  CustomerUpdateProfileRequest,
} from '@mocha-house/contracts';
import { Prisma, type TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';

type CustomerRow = Prisma.CustomerGetPayload<Record<string, never>>;

// Upper bound on a stored display name. Generous for real names while
// still ruling out abuse; the customer-auth boundary keeps the provider's
// own limits separate — this is purely the Mocha House profile field.
const DISPLAY_NAME_MAX_LENGTH = 80;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  // JIT provisioning: by the time this runs, the customer-auth boundary has
  // already verified the caller's identity — Cognito (or its local/test
  // stand-in) proved who they are, so the first successful authentication
  // for a given (provider, subject) creates the Mocha House Customer record,
  // and every later one resyncs the basic profile fields from the identity
  // provider's latest claims. This is the "authenticated subject with no
  // permitted customer relationship" case the architecture calls out —
  // resolved by creating the record rather than rejecting the request.
  // Fields are only overwritten when the identity actually supplied a
  // value, so a claim set missing email/name (e.g. the dev auth boundary
  // for a non-email identifier) never blanks out a previously known value.
  //
  // displayName is deliberately NOT in the `update` clause: the provider's
  // name claim seeds it once, at creation, and from then on it is a
  // Mocha-House-owned, customer-editable field (see updateProfile) that a
  // later sign-in must never silently overwrite with the (lower-authority)
  // provider value. `email` stays authoritative to the provider identity —
  // it is not customer-editable in this milestone — and `emailVerifiedAt`
  // is only ever set by AuthController.verify, never here on update.
  //
  // Milestone S0D-2B-1 — tenant ownership. A Customer is tenant-owned
  // (ADR-1), and its tenant comes ONLY from the explicit, server-resolved
  // TenantContext passed in by the request boundary — never from the
  // identity, the email, the request, SINGLE_TENANT_ID or the async context.
  //
  // TRANSITIONAL: (externalProvider, externalSubject) is still GLOBALLY
  // unique (tenant-scoping it is S0D-3 / S0G), so one identity can own at
  // most one Customer across all tenants for now. The resolver therefore
  // fails closed: an identity whose Customer belongs to a DIFFERENT tenant
  // is refused, never adopted, transferred or updated. The former single
  // upsert is split into look-up → ownership check → update-or-create so the
  // check always runs BEFORE any write.
  async resolveOrCreateFromIdentity(
    identity: CustomerIdentity,
    tenant: TenantContext,
  ): Promise<CustomerRow> {
    const identityKey = {
      externalProvider_externalSubject: {
        externalProvider: identity.provider,
        externalSubject: identity.subject,
      },
    };

    const existing = await this.prisma.customer.findUnique({
      where: identityKey,
    });
    if (existing) {
      return this.resyncOwnedCustomer(existing, identity, tenant);
    }

    try {
      return await this.prisma.customer.create({
        data: {
          tenantId: tenant.tenantId,
          externalProvider: identity.provider,
          externalSubject: identity.subject,
          email: identity.email,
          displayName: identity.name,
          // Set once, at creation, straight from the provider's own
          // authoritative claim on the verified token — this is what
          // recovers the Milestone 4C registration partial-failure window
          // (Cognito SignUp succeeded but the Customer row never got
          // created) without any reconciliation job: the customer's first
          // successful sign-in after verifying with Cognito JIT-creates this
          // row here, and its emailVerified claim is already true by then,
          // so the row is never incorrectly stuck unverified. Never touched
          // on update (below) — a real verification, once recorded, is
          // never revisited by a later sign-in's claims.
          emailVerifiedAt: identity.emailVerified ? new Date() : null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Lost the first-authentication race: a concurrent request created
        // this identity's Customer first. Re-read the winner and apply the
        // SAME ownership check before returning or touching it.
        const winner = await this.prisma.customer.findUniqueOrThrow({
          where: identityKey,
        });
        return this.resyncOwnedCustomer(winner, identity, tenant);
      }
      throw error;
    }
  }

  // The existing-Customer half of resolveOrCreateFromIdentity: refuse a
  // Customer owned by another tenant (with a generic message that reveals
  // nothing about it), otherwise apply exactly the resync the former
  // upsert's `update` branch applied.
  private async resyncOwnedCustomer(
    customer: CustomerRow,
    identity: CustomerIdentity,
    tenant: TenantContext,
  ): Promise<CustomerRow> {
    if (customer.tenantId !== tenant.tenantId) {
      throw new ForbiddenException('This account cannot be used here.');
    }
    return this.prisma.customer.update({
      where: { id: customer.id },
      data: {
        ...(identity.email ? { email: identity.email } : {}),
      },
    });
  }

  // Applies a customer-initiated profile edit (Milestone 4E). Only ever
  // writes `displayName` — the provider identity (externalProvider/
  // externalSubject), account status, email, and email-verification
  // timestamp are structurally untouchable here because they are never in
  // the `data` payload. The caller passes the Customer.id resolved from the
  // authenticated identity, so a customer can only ever update their own
  // record. Unknown request fields are ignored, never persisted.
  async updateProfile(
    customerId: string,
    request: CustomerUpdateProfileRequest,
  ): Promise<CustomerRow> {
    return this.prisma.customer.update({
      where: { id: customerId },
      data: { displayName: normalizeDisplayName(request?.displayName) },
    });
  }

  toProfile(customer: CustomerRow): CustomerProfile {
    return {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName,
      status: customer.status,
      emailVerified: customer.emailVerifiedAt !== null,
      createdAt: customer.createdAt.toISOString(),
    };
  }

  // Used only by the registration/verification flow (Milestone 4C) to find
  // the Customer created moments earlier at registration, scoped by
  // provider so a 'dev' and a 'cognito' row can never collide on the same
  // email. Deliberately a lookup, not an identity key: the authoritative
  // identity is always (externalProvider, externalSubject) — see
  // resolveOrCreateFromIdentity — this exists only because Cognito's
  // ConfirmSignUp response carries no subject to resolve by directly, and
  // there is no non-privileged Cognito API that returns one either
  // (retrieving an existing user's sub requires AdminGetUser, a
  // credentialed Admin API this architecture deliberately does not use).
  //
  // Never guesses: if more than one Customer row under this provider
  // somehow shares this email — which normal operation cannot produce,
  // since each provider is expected to enforce its own username/email
  // uniqueness (Cognito: email IS the Username) — this refuses to pick one
  // rather than silently binding verification state to an arbitrary
  // customer. That would be a genuine data anomaly elsewhere, not a
  // request-level error, so it throws rather than returning null.
  async findByEmailAndProvider(
    provider: string,
    email: string,
  ): Promise<CustomerRow | null> {
    const matches = await this.prisma.customer.findMany({
      where: { externalProvider: provider, email },
    });

    if (matches.length > 1) {
      throw new Error(
        `Ambiguous Customer lookup: ${matches.length} rows found for provider "${provider}" and this email.`,
      );
    }

    return matches[0] ?? null;
  }

  async markEmailVerified(customerId: string): Promise<CustomerRow> {
    return this.prisma.customer.update({
      where: { id: customerId },
      data: { emailVerifiedAt: new Date() },
    });
  }
}

// The single, deliberate rule for a submitted display name:
//   - the field must be present and be a string or explicitly null
//     (a missing field, or any other type, is a bad request — a one-field
//     PATCH with nothing in it must not silently clear the name)
//   - leading/trailing whitespace trimmed; internal whitespace runs
//     collapsed to a single space
//   - once normalized, an empty result is stored as null ("no display
//     name") rather than an empty string, so a blank submission is never
//     silently persisted as data
//   - capped at DISPLAY_NAME_MAX_LENGTH characters
function normalizeDisplayName(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(
      'displayName is required and must be a string or null.',
    );
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }

  return normalized;
}
