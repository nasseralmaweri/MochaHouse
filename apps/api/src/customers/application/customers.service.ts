import { Injectable } from '@nestjs/common';
import type { CustomerProfile } from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';

type CustomerRow = Prisma.CustomerGetPayload<Record<string, never>>;

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
        ...(identity.name ? { displayName: identity.name } : {}),
      },
    });
  }

  toProfile(customer: CustomerRow): CustomerProfile {
    return {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName,
      status: customer.status,
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
