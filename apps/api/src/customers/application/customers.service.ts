import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  CUSTOMER_ACCOUNT_RESTRICTED,
  CUSTOMER_ACCOUNT_UNAVAILABLE,
  CUSTOMER_EMAIL_NOT_VERIFIED,
  CUSTOMER_NOT_ENROLLED,
  type CustomerAccountStatus,
  type CustomerEnrollmentRequest,
  type CustomerProfile,
  type CustomerUpdateProfileRequest,
} from '@mocha-house/contracts';
import { Prisma, type TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { businessDisplayName } from '../../tenancy/business-name';

type CustomerRow = Prisma.CustomerGetPayload<Record<string, never>>;

// SC4f-2 — what a customer route needs from the profile (see
// CustomersService.requireCustomer).
export type CustomerAccess = 'profile' | 'read' | 'write';

const ALLOWED_STATUSES: Readonly<
  Record<CustomerAccess, readonly CustomerAccountStatus[]>
> = {
  profile: ['ACTIVE', 'RESTRICTED', 'DEACTIVATED'],
  read: ['ACTIVE', 'RESTRICTED'],
  write: ['ACTIVE'],
};

// Refuses a profile whose status does not allow this access. The answer
// says only that the account is limited AT THIS BUSINESS — never why, and
// never anything about the login's other businesses.
export function assertCustomerAccess(
  status: CustomerAccountStatus,
  access: CustomerAccess,
): void {
  if (ALLOWED_STATUSES[access].includes(status)) return;
  if (status === 'RESTRICTED') {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: CUSTOMER_ACCOUNT_RESTRICTED,
      message:
        'Your account at this restaurant is limited. Please contact the restaurant for help.',
    });
  }
  throw new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: CUSTOMER_ACCOUNT_UNAVAILABLE,
    message:
      'Your account at this restaurant is not available. Please contact the restaurant for help.',
  });
}

// The login's profile key AT THIS BUSINESS.
function identityKey(identity: CustomerIdentity, tenant: TenantContext) {
  return {
    tenantId: tenant.tenantId,
    externalProvider: identity.provider,
    externalSubject: identity.subject,
  };
}

// Upper bound on a stored display name. Generous for real names while
// still ruling out abuse; the customer-auth boundary keeps the provider's
// own limits separate — this is purely the Mocha House profile field.
const DISPLAY_NAME_MAX_LENGTH = 80;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  // SC4f-2 — ONE CENTERIVO login, a SEPARATE profile per business (owner
  // decisions G1–G5). A Customer row is one business's profile of one login:
  // (tenantId, externalProvider, externalSubject) is unique, and the
  // business always comes from the request's server-resolved TenantContext —
  // never from the identity, the email, the request body, SINGLE_TENANT_ID
  // or another business's profile.
  //
  // A profile is created ONLY by an explicit action at that business:
  //   * registering there (createAtRegistration), or
  //   * choosing to join it (enroll — POST /customers/me/enrollment).
  // Every other customer route resolves the EXISTING profile
  // (requireCustomer) and refuses with CUSTOMER_NOT_ENROLLED when there is
  // none — never creating one, never borrowing another business's, never
  // matching by email. An interrupted registration (the login exists but its
  // profile was never written) is completed by the same explicit join; no
  // profile is ever created just because the login has none anywhere.
  //
  // Account status is the business's own decision about this profile and
  // never affects the login or the customer's profiles at other businesses:
  //   'profile' — the customer's own profile and consent: every status (so a
  //               restricted or deactivated customer is told why and can
  //               always withdraw marketing consent);
  //   'read'    — history and balances (orders, loyalty, saved locations):
  //               ACTIVE and RESTRICTED;
  //   (withdrawing marketing consent is 'profile'; opting in is 'write')
  //   'write'   — ordering, redemption, gift cards and other changes:
  //               ACTIVE only.
  async requireCustomer(
    identity: CustomerIdentity,
    tenant: TenantContext,
    access: CustomerAccess,
  ): Promise<CustomerRow> {
    const customer = await this.prisma.customer.findUnique({
      where: {
        tenantId_externalProvider_externalSubject: identityKey(
          identity,
          tenant,
        ),
      },
    });
    if (!customer) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: CUSTOMER_NOT_ENROLLED,
        message: 'Join this restaurant to use your account here.',
        businessName: await businessDisplayName(this.prisma, tenant.tenantId),
      });
    }
    assertCustomerAccess(customer.status, access);
    // A deactivated profile is only ever read here, never written.
    if (customer.status === 'DEACTIVATED') return customer;
    return this.resyncEmail(customer, identity);
  }

  // The customer's explicit choice to join this business. Requires a login
  // whose email the identity provider has verified. Idempotent and safe
  // under concurrency: the database's unique key decides, and a profile that
  // already exists is returned exactly as it is — its status, consent and
  // data unchanged, so joining again can never lift a restriction. A new
  // profile starts from the verified login's own claims (and the name the
  // customer gave while joining), with marketing consent OFF; nothing is
  // copied from any other business.
  async enroll(
    identity: CustomerIdentity,
    tenant: TenantContext,
    request: CustomerEnrollmentRequest | undefined,
  ): Promise<{ customer: CustomerRow; created: boolean }> {
    if (identity.emailVerified !== true) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: CUSTOMER_EMAIL_NOT_VERIFIED,
        message: 'Verify your email address before joining a restaurant.',
      });
    }
    const displayName =
      request?.displayName === undefined
        ? seedDisplayName(identity.name)
        : normalizeDisplayName(request.displayName);
    return this.createProfile(identity, tenant, {
      displayName,
      emailVerifiedAt: new Date(),
    });
  }

  // Registration at this business: the customer has just chosen it by
  // signing up here. The login is brand new (the identity provider refuses
  // an email it already knows), so this is its first profile; a concurrent
  // duplicate resolves to the same row.
  async createAtRegistration(
    identity: CustomerIdentity,
    tenant: TenantContext,
  ): Promise<CustomerRow> {
    const { customer } = await this.createProfile(identity, tenant, {
      displayName: seedDisplayName(identity.name),
      // Registration always precedes verification: never assumed verified.
      emailVerifiedAt: null,
    });
    return customer;
  }

  private async createProfile(
    identity: CustomerIdentity,
    tenant: TenantContext,
    seed: { displayName: string | null; emailVerifiedAt: Date | null },
  ): Promise<{ customer: CustomerRow; created: boolean }> {
    const key = identityKey(identity, tenant);
    const existing = await this.prisma.customer.findUnique({
      where: { tenantId_externalProvider_externalSubject: key },
    });
    if (existing) return { customer: existing, created: false };
    try {
      const customer = await this.prisma.customer.create({
        data: {
          tenantId: key.tenantId,
          externalProvider: key.externalProvider,
          externalSubject: key.externalSubject,
          email: identity.email,
          displayName: seed.displayName,
          emailVerifiedAt: seed.emailVerifiedAt,
          marketingEmailOptIn: false,
        },
      });
      return { customer, created: true };
    } catch (error) {
      // Checked structurally, like checkout and gift cards: `instanceof`
      // can miss the client's error class across module copies.
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        // Lost the race to a concurrent request for the same login at the
        // same business: that request's profile is this one.
        const winner = await this.prisma.customer.findUniqueOrThrow({
          where: { tenantId_externalProvider_externalSubject: key },
        });
        return { customer: winner, created: false };
      }
      throw error;
    }
  }

  // The identity provider stays authoritative for the login's email — but
  // only a VERIFIED address replaces the stored one (an unverified address
  // would otherwise inherit this profile's verified state and consent). A
  // claim set without one never blanks a known value. displayName is the
  // customer's own field at this business and is never overwritten here.
  private async resyncEmail(
    customer: CustomerRow,
    identity: CustomerIdentity,
  ): Promise<CustomerRow> {
    if (
      !identity.email ||
      identity.emailVerified !== true ||
      identity.email === customer.email
    ) {
      return customer;
    }
    return this.prisma.customer.update({
      where: { id: customer.id },
      data: { email: identity.email },
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
  // requireCustomer — this exists only because Cognito's
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
  //
  // SC4f-2 — scoped to the request's business: one login may hold a profile
  // at several businesses, and verifying here must only ever mark THIS
  // business's profile.
  async findByEmailAndProvider(
    provider: string,
    email: string,
    tenant: TenantContext,
  ): Promise<CustomerRow | null> {
    const matches = await this.prisma.customer.findMany({
      where: { tenantId: tenant.tenantId, externalProvider: provider, email },
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
// SC4f-2 — a new profile's name from the login's own claim: the same
// trimming as a customer edit, cut to the limit rather than refused (the
// claim is the identity provider's, not something the customer typed here).
function seedDisplayName(claim: string | null): string | null {
  if (typeof claim !== 'string') return null;
  const normalized = claim
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, DISPLAY_NAME_MAX_LENGTH)
    .trim();
  return normalized.length === 0 ? null : normalized;
}

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
