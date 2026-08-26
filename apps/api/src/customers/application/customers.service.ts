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
}
