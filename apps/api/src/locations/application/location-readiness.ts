import type { GettingStartedStepKey } from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';
import { isSelfServiceSetupPending } from '../../saas-billing/application/self-service-setup';

// SC4d — whether a business and its location are ready to take online
// orders, computed from real data on every call (nothing is stored). Used by
// the getting-started checklist and by the online-ordering switch, so the two
// can never disagree.

type Db = Prisma.TransactionClient | PrismaService;

export interface ReadinessLocation {
  id: string;
  addressLine1: string | null;
  city: string | null;
  countryCode: string | null;
  timeZone: string | null;
  phone: string | null;
  openingHoursSetAt: Date | null;
}

export const READINESS_LOCATION_SELECT = {
  id: true,
  addressLine1: true,
  city: true,
  countryCode: true,
  timeZone: true,
  phone: true,
  openingHoursSetAt: true,
} as const;

export interface LocationReadiness {
  profile: boolean;
  hours: boolean;
  menu: boolean;
  // The location's menu (its active assignment), when it has one.
  menuId: string | null;
}

// A business its owner created through self-service (SC4b). Only these
// businesses must complete setup before online ordering can be turned on;
// operator-provisioned businesses keep their existing behaviour.
export async function isSelfServiceBusiness(
  db: Db,
  tenantId: string,
): Promise<boolean> {
  return (
    (await db.ownerRegistration.count({
      where: { provisionedTenantId: tenantId },
    })) > 0
  );
}

// "Subscription or trial authorized": false only while a self-service
// business has not completed its first payment setup (SC4b/SC4c) — the same
// test that keeps its sales closed. An operator-managed business is not
// waiting on anything; a self-service business always has a subscription
// (SC4b), so one without any fails closed.
export async function isBillingAuthorized(
  db: Db,
  tenantId: string,
): Promise<boolean> {
  const subscription = await db.tenantSubscription.findUnique({
    where: { subscriberTenantId: tenantId },
    select: {
      billingMode: true,
      trialStartedAt: true,
      currentPeriodStart: true,
    },
  });
  if (!subscription) return !(await isSelfServiceBusiness(db, tenantId));
  return !(await isSelfServiceSetupPending(db, tenantId, subscription));
}

export async function locationReadiness(
  db: Db,
  tenantId: string,
  location: ReadinessLocation,
): Promise<LocationReadiness> {
  const profile =
    location.addressLine1 !== null &&
    location.city !== null &&
    location.countryCode !== null &&
    location.timeZone !== null &&
    location.phone !== null;

  const hours =
    location.openingHoursSetAt !== null &&
    (await db.locationOpeningPeriod.count({
      where: { tenantId, locationId: location.id },
    })) > 0;

  // The location's single active menu, resolved exactly as the Admin
  // location-menu screen resolves it (active assignment, active menu, lowest
  // menu id first).
  const assignment = await db.locationMenu.findFirst({
    where: {
      tenantId,
      locationId: location.id,
      isActive: true,
      menu: { tenantId, isActive: true },
    },
    orderBy: { menuId: 'asc' },
    select: { menuId: true },
  });

  let menu = false;
  if (assignment) {
    const placements = await db.menuProduct.findMany({
      where: {
        tenantId,
        menuId: assignment.menuId,
        isActive: true,
        product: {
          tenantId,
          isActive: true,
          category: { tenantId, isActive: true },
        },
      },
      select: {
        product: {
          select: {
            basePrice: true,
            priceOverrides: {
              where: {
                tenantId,
                locationId: location.id,
                menuId: assignment.menuId,
              },
              select: { price: true },
            },
            availabilityOverrides: {
              where: {
                tenantId,
                locationId: location.id,
                menuId: assignment.menuId,
              },
              select: { isAvailable: true },
            },
          },
        },
      },
    });
    // At least one product a customer could actually buy here: shown on the
    // menu, active, available at this location and priced above zero.
    menu = placements.some(({ product }) => {
      const price = product.priceOverrides[0]?.price ?? product.basePrice;
      const available = product.availabilityOverrides[0]?.isAvailable ?? true;
      return available && price !== null && price > 0;
    });
  }

  return { profile, hours, menu, menuId: assignment?.menuId ?? null };
}

// The steps a self-service business must finish before its location may
// turn online ordering on, in checklist order.
export function missingForOrdering(
  billing: boolean,
  readiness: LocationReadiness,
): GettingStartedStepKey[] {
  const missing: GettingStartedStepKey[] = [];
  if (!billing) missing.push('billing');
  if (!readiness.profile) missing.push('profile');
  if (!readiness.hours) missing.push('hours');
  if (!readiness.menu) missing.push('menu');
  return missing;
}
