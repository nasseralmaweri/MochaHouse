import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LocationSummary } from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';

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

  async addForCustomer(
    customerId: string,
    locationId: string,
  ): Promise<LocationSummary[]> {
    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new BadRequestException('locationId is required.');
    }

    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });

    // Eligibility to be *saved* = the location exists and is an active
    // Mocha House location. Digital ordering being temporarily disabled
    // does NOT block saving — a customer may still prefer such a location;
    // orderability is re-checked live when they actually start an order.
    // A missing id and an inactive location collapse to the same response:
    // neither can be newly preferred.
    if (!location || !location.isActive) {
      throw new NotFoundException('That location is not available to save.');
    }

    // Idempotent: a repeat add is a no-op on the existing row, never a
    // duplicate or a unique-constraint error.
    await this.prisma.customerPreferredLocation.upsert({
      where: { customerId_locationId: { customerId, locationId } },
      create: { customerId, locationId },
      update: {},
    });

    return this.listForCustomer(customerId);
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
