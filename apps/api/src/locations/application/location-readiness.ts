import type {
  GettingStartedStep,
  GettingStartedStepKey,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';
import { awaitingFirstAuthorization } from '../../saas-billing/domain/payment-setup';

// SC4d — whether a business and its location are ready to take online
// orders, computed from real data on every call (nothing is stored). The ONE
// implementation behind the business's getting-started checklist, the
// online-ordering switch and (SC4e) the Platform Console's onboarding
// progress, so they can never disagree.
//
// Batched: each function answers for any number of businesses or locations
// with a fixed handful of queries (never one per row). The single-item
// helpers are batches of one.

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

// --- businesses ---------------------------------------------------------------

// The businesses their owners created through self-service (SC4b). Only these
// must complete setup before online ordering can be turned on;
// operator-provisioned businesses keep their existing behaviour.
export async function selfServiceBusinesses(
  db: Db,
  tenantIds: readonly string[],
): Promise<Set<string>> {
  if (tenantIds.length === 0) return new Set();
  const rows = await db.ownerRegistration.findMany({
    where: { provisionedTenantId: { in: [...tenantIds] } },
    select: { provisionedTenantId: true },
  });
  return new Set(rows.map((row) => row.provisionedTenantId!));
}

export async function isSelfServiceBusiness(
  db: Db,
  tenantId: string,
): Promise<boolean> {
  return (await selfServiceBusinesses(db, [tenantId])).has(tenantId);
}

// "Subscription or trial authorized": false only while a self-service
// business has not completed its first payment setup (SC4b/SC4c) — the same
// test that keeps its sales closed. An operator-managed business is not
// waiting on anything; a self-service business always has a subscription
// (SC4b), so one without any fails closed.
export async function billingAuthorized(
  db: Db,
  tenantIds: readonly string[],
  selfService?: Set<string>,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (tenantIds.length === 0) return result;
  const owned = selfService ?? (await selfServiceBusinesses(db, tenantIds));
  const subscriptions = await db.tenantSubscription.findMany({
    where: { subscriberTenantId: { in: [...tenantIds] } },
    select: {
      subscriberTenantId: true,
      billingMode: true,
      trialStartedAt: true,
      currentPeriodStart: true,
    },
  });
  const byTenant = new Map(
    subscriptions.map((row) => [row.subscriberTenantId, row]),
  );
  for (const tenantId of tenantIds) {
    const subscription = byTenant.get(tenantId);
    const isOwned = owned.has(tenantId);
    result.set(
      tenantId,
      subscription
        ? !(isOwned && awaitingFirstAuthorization(subscription))
        : !isOwned,
    );
  }
  return result;
}

export async function isBillingAuthorized(
  db: Db,
  tenantId: string,
): Promise<boolean> {
  return (await billingAuthorized(db, [tenantId])).get(tenantId)!;
}

// --- locations ----------------------------------------------------------------

export async function locationsReadiness(
  db: Db,
  locations: ReadonlyArray<ReadinessLocation & { tenantId: string }>,
): Promise<Map<string, LocationReadiness>> {
  const result = new Map<string, LocationReadiness>();
  if (locations.length === 0) return result;
  const locationIds = locations.map((location) => location.id);
  const tenantIds = [
    ...new Set(locations.map((location) => location.tenantId)),
  ];

  const [periods, assignments] = await Promise.all([
    db.locationOpeningPeriod.groupBy({
      by: ['locationId'],
      where: { tenantId: { in: tenantIds }, locationId: { in: locationIds } },
      _count: { _all: true },
    }),
    // Each location's single active menu, resolved exactly as the Admin
    // location-menu screen resolves it (active assignment, active menu,
    // lowest menu id first).
    db.locationMenu.findMany({
      where: {
        tenantId: { in: tenantIds },
        locationId: { in: locationIds },
        isActive: true,
        menu: { isActive: true },
      },
      orderBy: [{ locationId: 'asc' }, { menuId: 'asc' }],
      select: { tenantId: true, locationId: true, menuId: true },
    }),
  ]);
  const periodCount = new Map(
    periods.map((row) => [row.locationId, row._count._all]),
  );
  const menuOf = new Map<string, string>();
  for (const row of assignments) {
    if (!menuOf.has(row.locationId)) menuOf.set(row.locationId, row.menuId);
  }

  const menuIds = [...new Set(menuOf.values())];
  const placements = menuIds.length
    ? await db.menuProduct.findMany({
        where: {
          tenantId: { in: tenantIds },
          menuId: { in: menuIds },
          isActive: true,
          product: { isActive: true, category: { isActive: true } },
        },
        select: {
          menuId: true,
          product: {
            select: {
              basePrice: true,
              priceOverrides: {
                where: {
                  locationId: { in: locationIds },
                  menuId: { in: menuIds },
                },
                select: { locationId: true, menuId: true, price: true },
              },
              availabilityOverrides: {
                where: {
                  locationId: { in: locationIds },
                  menuId: { in: menuIds },
                },
                select: { locationId: true, menuId: true, isAvailable: true },
              },
            },
          },
        },
      })
    : [];

  for (const location of locations) {
    const profile =
      location.addressLine1 !== null &&
      location.city !== null &&
      location.countryCode !== null &&
      location.timeZone !== null &&
      location.phone !== null;
    const hours =
      location.openingHoursSetAt !== null &&
      (periodCount.get(location.id) ?? 0) > 0;
    const menuId = menuOf.get(location.id) ?? null;
    // At least one product a customer could actually buy here: shown on the
    // menu, active, available at this location and priced above zero.
    const menu =
      menuId !== null &&
      placements.some(({ menuId: placedOn, product }) => {
        if (placedOn !== menuId) return false;
        const price =
          product.priceOverrides.find(
            (o) => o.locationId === location.id && o.menuId === menuId,
          )?.price ?? product.basePrice;
        const available =
          product.availabilityOverrides.find(
            (o) => o.locationId === location.id && o.menuId === menuId,
          )?.isAvailable ?? true;
        return available && price !== null && price > 0;
      });
    result.set(location.id, { profile, hours, menu, menuId });
  }
  return result;
}

export async function locationReadiness(
  db: Db,
  tenantId: string,
  location: ReadinessLocation,
): Promise<LocationReadiness> {
  return (await locationsReadiness(db, [{ ...location, tenantId }])).get(
    location.id,
  )!;
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

// --- the checklist ------------------------------------------------------------

export interface OnboardingProgress {
  steps: GettingStartedStep[];
  completedCount: number;
  totalCount: number;
  setupComplete: boolean;
  // The business's FIRST location (oldest first) and its menu, when present.
  locationId: string | null;
  menuId: string | null;
}

// The getting-started checklist (SC4d) for each business, in the same order
// of steps the business sees.
export async function onboardingProgress(
  db: Db,
  tenantIds: readonly string[],
): Promise<Map<string, OnboardingProgress>> {
  const result = new Map<string, OnboardingProgress>();
  if (tenantIds.length === 0) return result;
  const ids = [...new Set(tenantIds)];
  const owned = await selfServiceBusinesses(db, ids);
  const [billing, locations] = await Promise.all([
    billingAuthorized(db, ids, owned),
    db.location.findMany({
      where: { tenantId: { in: ids } },
      orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        ...READINESS_LOCATION_SELECT,
        tenantId: true,
        isDigitalOrderingEnabled: true,
      },
    }),
  ]);
  const firstLocation = new Map<string, (typeof locations)[number]>();
  for (const location of locations) {
    if (!firstLocation.has(location.tenantId)) {
      firstLocation.set(location.tenantId, location);
    }
  }
  const readiness = await locationsReadiness(db, [...firstLocation.values()]);

  for (const tenantId of ids) {
    const location = firstLocation.get(tenantId) ?? null;
    const ready = location ? readiness.get(location.id)! : null;
    const steps: GettingStartedStep[] = [
      { key: 'business', done: true },
      { key: 'billing', done: billing.get(tenantId)! },
      { key: 'location', done: location !== null },
      { key: 'profile', done: ready?.profile ?? false },
      { key: 'hours', done: ready?.hours ?? false },
      { key: 'menu', done: ready?.menu ?? false },
      { key: 'ordering', done: location?.isDigitalOrderingEnabled ?? false },
    ];
    const completedCount = steps.filter((step) => step.done).length;
    result.set(tenantId, {
      steps,
      completedCount,
      totalCount: steps.length,
      setupComplete: completedCount === steps.length,
      locationId: location?.id ?? null,
      menuId: ready?.menuId ?? null,
    });
  }
  return result;
}
