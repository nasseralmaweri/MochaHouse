// SC4f-2 — a customer profile exists at a business only once the customer
// has registered there or explicitly joined it (CustomersService.enroll);
// customer routes never create one on first use. Tests that exercise a
// signed-in customer at a business set that profile up with this helper —
// the test-only equivalent of joining — instead of relying on creation by
// first use.

interface CustomerFixtureClient {
  customer: {
    upsert(args: {
      where: {
        tenantId_externalProvider_externalSubject: {
          tenantId: string;
          externalProvider: string;
          externalSubject: string;
        };
      };
      update: Record<string, never>;
      create: {
        tenantId: string;
        externalProvider: string;
        externalSubject: string;
        email: string | null;
        displayName: string | null;
        emailVerifiedAt: Date | null;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}

export interface TestCustomerIdentity {
  provider: string;
  subject: string;
  email?: string | null;
  name?: string | null;
  emailVerified?: boolean | null;
}

// The login's profile at this business, created if missing (an existing
// profile is returned unchanged). Returns the profile id.
export async function enrollTestCustomer(
  client: CustomerFixtureClient,
  tenantId: string,
  identity: TestCustomerIdentity,
): Promise<string> {
  const row = await client.customer.upsert({
    where: {
      tenantId_externalProvider_externalSubject: {
        tenantId,
        externalProvider: identity.provider,
        externalSubject: identity.subject,
      },
    },
    update: {},
    create: {
      tenantId,
      externalProvider: identity.provider,
      externalSubject: identity.subject,
      email: identity.email ?? null,
      displayName: identity.name ?? null,
      emailVerifiedAt: identity.emailVerified ? new Date() : null,
    },
    select: { id: true },
  });
  return row.id;
}
