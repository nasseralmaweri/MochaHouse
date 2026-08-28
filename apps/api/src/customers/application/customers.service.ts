import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  CustomerProfile,
  CustomerUpdateProfileRequest,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
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
  async resolveOrCreateFromIdentity(
    identity: CustomerIdentity,
  ): Promise<CustomerRow> {
    return this.prisma.customer.upsert({
      where: {
        externalProvider_externalSubject: {
          externalProvider: identity.provider,
          externalSubject: identity.subject,
        },
      },
      create: {
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
      update: {
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
