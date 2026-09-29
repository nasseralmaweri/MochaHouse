import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LocationSummary } from '@mocha-house/contracts';
import { Prisma, type TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantOwnership } from '../../tenancy/tenant-ownership';

type LocationRow = Prisma.LocationGetPayload<Record<string, never>>;

function toLocationSummary(location: LocationRow): LocationSummary {
  return {
    id: location.id,
    name: location.name,
    slug: location.slug,
    // The live orderability signal for the account UI — read fresh on
    // every request, never frozen into the preference.
    isDigitalOrderingEnabled: location.isDigitalOrderingEnabled,
  };
}

// Milestone 4F — the customer's managed set of preferred Mocha House
// locations. Every method takes the Customer.id the caller already
// resolved from the verified identity, so a customer can only ever touch
// their own rows. The underlying Location records are authoritative and
// read-only here — this service never creates, mutates, or deletes a
// Location.
@Injectable()
export class CustomerPreferredLocationsService {
  constructor(private readonly prisma: PrismaService) {}

  // Deterministic order (name, then id) so the account list is stable
  // across requests. Only locations that are still active are returned —
  // a location going inactive drops out of the list without deleting the
  // stored row, so it reappears if the location is reactivated.
  async listForCustomer(customerId: string): Promise<LocationSummary[]> {
    const rows = await this.prisma.customerPreferredLocation.findMany({
      where: { customerId, location: { isActive: true } },
      include: { location: true },
      orderBy: [{ location: { name: 'asc' } }, { locationId: 'asc' }],
    });
    return rows.map((row) => toLocationSummary(row.location));
  }

  // Milestone S0D-2B-2 — tenant ownership. Takes the server-resolved
  // Customer row (not a bare id) plus the request's explicit TenantContext.
  // The row's tenant is copied from that Customer after re-asserting it
  // belongs to the request's tenant, and the Location must belong to the
  // SAME tenant — so a join row can never span two tenants. The
  // client-supplied locationId is only a lookup key.
  async addForCustomer(
    customer: { id: string; tenantId: string },
    locationId: string,
    tenant: TenantContext,
  ): Promise<LocationSummary[]> {
    const tenantId = requireTenantOwnership(
      customer,
      tenant,
      'Customer not found.',
    );

    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new BadRequestException('locationId is required.');
    }

    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    // Eligibility to be *saved* = the location exists, is an active Mocha
    // House location, and belongs to the customer's tenant. Digital
    // ordering being temporarily disabled does NOT block saving — a
    // customer may still prefer such a location; orderability is
    // re-checked live when they actually start an order. A missing id, an
    // inactive location and another tenant's location all collapse to the
    // same response, so this can never confirm another tenant's location
    // exists.
    if (!location || !location.isActive || location.tenantId !== tenantId) {
      throw new NotFoundException('That location is not available to save.');
    }

    // Idempotent: a repeat add is a no-op on the existing row, never a
    // duplicate or a unique-constraint error.
    await this.prisma.customerPreferredLocation.upsert({
      where: {
        customerId_locationId: { customerId: customer.id, locationId },
      },
      create: { tenantId, customerId: customer.id, locationId },
      update: {},
    });

    return this.listForCustomer(customer.id);
  }

  async removeForCustomer(
    customerId: string,
    locationId: string,
  ): Promise<LocationSummary[]> {
    // Scoped to this customer's own rows. deleteMany so removing a relation
    // that is already absent is a predictable no-op (count 0), never a 404
    // — DELETE here is idempotent and always returns the current set.
    await this.prisma.customerPreferredLocation.deleteMany({
      where: { customerId, locationId },
    });

    return this.listForCustomer(customerId);
  }
}
