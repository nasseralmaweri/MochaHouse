import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LOCATION_LIMIT_REACHED,
  formatClockMinutes,
  slugifyCatalogName,
  type AdminLocationDetail,
  type LocationLimitReachedBody,
  type StoredOpeningPeriod,
  type ValidLocationProfile,
} from '@mocha-house/contracts';
import type { Prisma, TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { firstFreeSlug } from '../../catalog/application/catalog-creation.service';
import { LocationsService } from './locations.service';

// SC4d — creating a business's first location, and its profile and opening
// hours.
//
// Every write is for the server-resolved business only (`tenant`); a location
// id of another business reads exactly like a missing one, and the composite
// (tenantId, locationId) foreign key is the database backstop. Each change
// and its audit event commit in one transaction.
//
// How many locations a business may create is a policy here, not a limit in
// the data model or the API: SC4d allows a business its FIRST location only
// (D3). Raising SELF_SERVICE_LOCATION_LIMIT (or deciding it per plan) is all
// a multi-location business needs; the routes, tables and screens already
// work with any number.
export const SELF_SERVICE_LOCATION_LIMIT = 1;

const LOCATION_SLUG_MAX_LENGTH = 80;

@Injectable()
export class LocationSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    private readonly locations: LocationsService,
  ) {}

  async createLocation(
    input: ValidLocationProfile,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminLocationDetail> {
    authorization.assertCorporate('locations.create');
    const tenantId = tenant.tenantId;

    const locationId = await this.prisma.$transaction(async (tx) => {
      // One location-creating request per business at a time: concurrent or
      // repeated submissions queue on the business row, and every one after
      // the first sees the location the first created.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;

      const existing = await tx.location.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: SELF_SERVICE_LOCATION_LIMIT,
      });
      if (existing.length >= SELF_SERVICE_LOCATION_LIMIT) {
        const body: LocationLimitReachedBody = {
          code: LOCATION_LIMIT_REACHED,
          message:
            'Your business already has its location. Adding more locations is not available yet.',
          locationId: existing[0]?.id ?? null,
        };
        throw new ConflictException(body);
      }

      const base = slugifyCatalogName(input.name) || 'location';
      const taken = await tx.location.findMany({
        where: {
          tenantId,
          slug: { startsWith: base.slice(0, LOCATION_SLUG_MAX_LENGTH - 6) },
        },
        select: { slug: true },
      });
      const slug = firstFreeSlug(base, new Set(taken.map((row) => row.slug)));

      const created = await tx.location.create({
        data: {
          tenantId,
          name: input.name,
          slug,
          isActive: true,
          // D4 — explicit, whatever the column default: a new location takes
          // no online orders until its owner turns ordering on, and that
          // needs the setup and billing checks (LocationsService).
          isDigitalOrderingEnabled: false,
          ...profileData(input),
        },
        select: { id: true, slug: true },
      });
      await this.audit.recordLocationCreated(tx, {
        actorInternalUserId,
        locationId: created.id,
        after: {
          name: input.name,
          slug: created.slug,
          isDigitalOrderingEnabled: false,
          ...profileData(input),
        },
      });
      return created.id;
    });

    return this.detail(locationId, tenant);
  }

  async updateProfile(
    locationId: string,
    input: ValidLocationProfile,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminLocationDetail> {
    authorization.assertCorporate('locations.edit');
    const tenantId = tenant.tenantId;

    await this.prisma.$transaction(async (tx) => {
      const before = await lockLocation(tx, locationId, tenantId);
      await tx.location.update({
        where: { id: before.id },
        data: { name: input.name, ...profileData(input) },
      });
      await this.audit.recordLocationProfileUpdated(tx, {
        actorInternalUserId,
        locationId: before.id,
        before: {
          name: before.name,
          addressLine1: before.addressLine1,
          addressLine2: before.addressLine2,
          city: before.city,
          region: before.region,
          postalCode: before.postalCode,
          countryCode: before.countryCode,
          timeZone: before.timeZone,
          phone: before.phone,
        },
        after: { name: input.name, ...profileData(input) },
      });
    });

    return this.detail(locationId, tenant);
  }

  // The whole week at once (validated by `validateOpeningHours`). Saving an
  // empty week is allowed (closed every day) and still counts as "set".
  async setOpeningHours(
    locationId: string,
    periods: StoredOpeningPeriod[],
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminLocationDetail> {
    authorization.assertCorporate('locations.edit');
    const tenantId = tenant.tenantId;

    await this.prisma.$transaction(async (tx) => {
      // The location row lock serializes concurrent saves of the same week.
      const location = await lockLocation(tx, locationId, tenantId);
      if (location.timeZone === null) {
        throw new BadRequestException(
          "Set the location's time zone before its opening hours.",
        );
      }
      const before = await tx.locationOpeningPeriod.findMany({
        where: { tenantId, locationId: location.id },
        orderBy: [{ dayOfWeek: 'asc' }, { opensAtMinute: 'asc' }],
        select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true },
      });
      await tx.locationOpeningPeriod.deleteMany({
        where: { tenantId, locationId: location.id },
      });
      if (periods.length > 0) {
        await tx.locationOpeningPeriod.createMany({
          data: periods.map((period) => ({
            tenantId,
            locationId: location.id,
            dayOfWeek: period.dayOfWeek,
            opensAtMinute: period.opensAtMinute,
            closesAtMinute: period.closesAtMinute,
          })),
        });
      }
      await tx.location.update({
        where: { id: location.id },
        data: { openingHoursSetAt: new Date() },
      });
      await this.audit.recordLocationOpeningHoursUpdated(tx, {
        actorInternalUserId,
        locationId: location.id,
        before: {
          isSet: location.openingHoursSetAt !== null,
          periods: before.map(describePeriod),
        },
        after: { isSet: true, periods: periods.map(describePeriod) },
      });
    });

    return this.detail(locationId, tenant);
  }

  // Read straight after this request's own committed write (the location is
  // this business's), so it is never null; no second authorization check.
  private async detail(
    locationId: string,
    tenant: TenantContext,
  ): Promise<AdminLocationDetail> {
    const detail = await this.locations.loadAdminLocationDetail(
      locationId,
      tenant,
    );
    if (!detail) {
      throw new NotFoundException('Location not found.');
    }
    return detail;
  }
}

// The location of THIS business, locked for the rest of the transaction; any
// other id (another business's, malformed or unknown) is a 404.
async function lockLocation(
  tx: Prisma.TransactionClient,
  locationId: string,
  tenantId: string,
) {
  if (locationId.includes('\u0000')) {
    throw new NotFoundException('Location not found.');
  }
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Location"
     WHERE id = ${locationId} AND "tenantId" = ${tenantId}
       FOR UPDATE`;
  if (locked.length === 0) {
    throw new NotFoundException('Location not found.');
  }
  return tx.location.findUniqueOrThrow({
    where: { id: locked[0].id },
    select: {
      id: true,
      name: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
      countryCode: true,
      timeZone: true,
      phone: true,
      openingHoursSetAt: true,
    },
  });
}

function profileData(input: ValidLocationProfile) {
  return {
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    countryCode: input.countryCode,
    timeZone: input.timeZone,
    phone: input.phone,
  };
}

function describePeriod(period: StoredOpeningPeriod): string {
  return `${period.dayOfWeek} ${formatClockMinutes(period.opensAtMinute)}-${formatClockMinutes(period.closesAtMinute)}`;
}
