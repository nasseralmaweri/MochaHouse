import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { INTERNAL_PERMISSION_KEYS } from '@mocha-house/contracts';
import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const location = await prisma.location.upsert({
    where: {
      slug: 'dearborn-heights',
    },
    update: {
      isActive: true,
      isDigitalOrderingEnabled: true,
    },
    create: {
      name: 'Mocha House - Dearborn Heights',
      slug: 'dearborn-heights',
      isActive: true,
      isDigitalOrderingEnabled: true,
    },
  });

  // A second representative location. Milestone 5D-1 introduces the Admin
  // locations read experience and its CORPORATE-vs-LOCATION scope model; a
  // single seeded location cannot demonstrate that a LOCATION-scoped user
  // sees only their own location. This one is intentionally left without an
  // assigned menu so the Admin detail view's "no assigned menu" state is
  // also exercisable locally. It is not wired into any customer flow.
  await prisma.location.upsert({
    where: {
      slug: 'ann-arbor',
    },
    update: {
      isActive: true,
      isDigitalOrderingEnabled: true,
    },
    create: {
      name: 'Mocha House - Ann Arbor',
      slug: 'ann-arbor',
      isActive: true,
      isDigitalOrderingEnabled: true,
    },
  });

  const category = await prisma.category.upsert({
    where: {
      slug: 'coffee',
    },
    update: {},
    create: {
      name: 'Coffee',
      slug: 'coffee',
      displayOrder: 1,
      isActive: true,
    },
  });

  const product = await prisma.product.upsert({
    where: {
      slug: 'drip-coffee',
    },
    update: {},
    create: {
      name: 'Drip Coffee',
      slug: 'drip-coffee',
      description: 'Freshly brewed drip coffee.',
      basePrice: 350,
      currency: 'USD',
      isActive: true,
      categoryId: category.id,
    },
  });

  const menu = await prisma.menu.upsert({
    where: {
      slug: 'main-menu',
    },
    update: {},
    create: {
      name: 'Main Menu',
      slug: 'main-menu',
      isActive: true,
    },
  });

  await prisma.menuProduct.upsert({
    where: {
      menuId_productId: {
        menuId: menu.id,
        productId: product.id,
      },
    },
    update: {},
    create: {
      menuId: menu.id,
      productId: product.id,
      displayOrder: 1,
      isActive: true,
    },
  });

  await prisma.locationMenu.upsert({
    where: {
      locationId_menuId: {
        locationId: location.id,
        menuId: menu.id,
      },
    },
    update: {},
    create: {
      locationId: location.id,
      menuId: menu.id,
      isActive: true,
    },
  });

  // Dearborn Heights / Drip Coffee should inherit Master pricing and
  // availability (no active override), so the effective price is the
  // product's $3.50 base price and it is available for ordering.
  await prisma.locationProductPriceOverride.deleteMany({
    where: {
      locationId: location.id,
      menuId: menu.id,
      productId: product.id,
    },
  });

  await prisma.locationProductAvailabilityOverride.deleteMany({
    where: {
      locationId: location.id,
      menuId: menu.id,
      productId: product.id,
    },
  });

  let sizeGroup = await prisma.modifierGroup.findFirst({
    where: {
      name: 'Size',
    },
  });

  if (!sizeGroup) {
    sizeGroup = await prisma.modifierGroup.create({
      data: {
        name: 'Size',
        displayOrder: 1,
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        isActive: true,
      },
    });
  } else {
    sizeGroup = await prisma.modifierGroup.update({
      where: {
        id: sizeGroup.id,
      },
      data: {
        displayOrder: 1,
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        isActive: true,
      },
    });
  }

  const sizeOptions = [
    {
      name: 'Small',
      priceAdjustment: 0,
      displayOrder: 1,
    },
    {
      name: 'Medium',
      priceAdjustment: 50,
      displayOrder: 2,
    },
    {
      name: 'Large',
      priceAdjustment: 100,
      displayOrder: 3,
    },
  ];

  for (const option of sizeOptions) {
    const existingOption = await prisma.modifierOption.findFirst({
      where: {
        modifierGroupId: sizeGroup.id,
        name: option.name,
      },
    });

    if (existingOption) {
      await prisma.modifierOption.update({
        where: {
          id: existingOption.id,
        },
        data: {
          priceAdjustment: option.priceAdjustment,
          displayOrder: option.displayOrder,
          isActive: true,
        },
      });
    } else {
      await prisma.modifierOption.create({
        data: {
          name: option.name,
          priceAdjustment: option.priceAdjustment,
          displayOrder: option.displayOrder,
          isActive: true,
          modifierGroupId: sizeGroup.id,
        },
      });
    }
  }

  await prisma.productModifierGroup.upsert({
    where: {
      productId_modifierGroupId: {
        productId: product.id,
        modifierGroupId: sizeGroup.id,
      },
    },
    update: {
      displayOrder: 1,
    },
    create: {
      productId: product.id,
      modifierGroupId: sizeGroup.id,
      displayOrder: 1,
    },
  });

  // Milestone 5A — one explicitly ACTIVE internal user for exercising the
  // local-dev internal-auth flow (INTERNAL_AUTH_PROVIDER=dev). The external
  // subject matches the deterministic marker the local-dev internal token
  // verifier derives from this identifier, so InternalAuthGuard resolves
  // this row directly. This is local-development test data only — never a
  // production credential (the local-dev provider performs no password
  // check) and never created in production, where a real Cognito internal
  // pool and an administrative invitation flow (Milestone 5B) apply.
  const internalAdminEmail = 'admin@mochahouse.test';
  const internalAdmin = await prisma.internalUser.upsert({
    where: { email: internalAdminEmail },
    update: { status: 'ACTIVE' },
    create: {
      externalProvider: 'internal-dev',
      externalSubject: `internal-dev:${internalAdminEmail}`,
      email: internalAdminEmail,
      displayName: 'Local Dev Admin',
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
  });

  // Milestone 5B — data-driven bootstrap. The platform-administrator role
  // holds EVERY permission in the code vocabulary; the seed re-synchronises
  // its permission rows to that vocabulary on every run, so a permission
  // added to INTERNAL_PERMISSION_KEYS is picked up by re-seeding. `isSystem`
  // is protective metadata only — this role is evaluated by exactly the
  // same AuthorizationService and PermissionGuard as any other role, with
  // no special-casing anywhere (no email check, no wildcard, no bypass).
  const platformAdminRole = await prisma.internalRole.upsert({
    where: { key: 'platform-administrator' },
    update: { displayName: 'Platform Administrator', isSystem: true },
    create: {
      key: 'platform-administrator',
      displayName: 'Platform Administrator',
      description:
        'Built-in role holding every internal permission. Granted at corporate scope for platform operators.',
      isSystem: true,
    },
  });

  await prisma.internalRolePermission.deleteMany({
    where: {
      roleId: platformAdminRole.id,
      permissionKey: { notIn: [...INTERNAL_PERMISSION_KEYS] },
    },
  });
  for (const permissionKey of INTERNAL_PERMISSION_KEYS) {
    await prisma.internalRolePermission.upsert({
      where: {
        roleId_permissionKey: { roleId: platformAdminRole.id, permissionKey },
      },
      update: {},
      create: { roleId: platformAdminRole.id, permissionKey },
    });
  }

  // Assign the local-dev internal admin the platform-administrator role at
  // CORPORATE scope (scopeId null). Idempotent: CORPORATE scope has no
  // scopeId, so it is matched by (user, role, scopeType).
  const existingAssignment =
    await prisma.internalUserRoleAssignment.findFirst({
      where: {
        internalUserId: internalAdmin.id,
        roleId: platformAdminRole.id,
        scopeType: 'CORPORATE',
      },
    });
  if (!existingAssignment) {
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: internalAdmin.id,
        roleId: platformAdminRole.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
  }

  // Milestone 5E-4 — the second built-in access level. Store Manager runs a
  // location day to day: orders, online ordering, and location price /
  // availability for the locations it is assigned to. It is intentionally a
  // LOCATION-scoped access level; it deliberately does NOT carry catalog
  // editing, menu composition, location editing, or any user / role
  // administration. Its permission rows are re-synchronised to exactly this
  // set on every run — the same deterministic mechanism as
  // platform-administrator above — so a change here converges by re-seeding.
  // The seed assigns it to NOBODY (not even the Local Dev Admin): who holds
  // Store Manager, and where, is decided through the Administration UI.
  const STORE_MANAGER_PERMISSION_KEYS = [
    'locations.view',
    'orders.view',
    'orders.manage_status',
    'catalog.overrides.manage',
    'locations.manage_digital_ordering',
  ] as const;

  const storeManagerRole = await prisma.internalRole.upsert({
    where: { key: 'store-manager' },
    update: {
      displayName: 'Store Manager',
      description:
        'Manages day-to-day orders, online ordering, prices and availability for assigned locations.',
      isSystem: true,
    },
    create: {
      key: 'store-manager',
      displayName: 'Store Manager',
      description:
        'Manages day-to-day orders, online ordering, prices and availability for assigned locations.',
      isSystem: true,
    },
  });

  await prisma.internalRolePermission.deleteMany({
    where: {
      roleId: storeManagerRole.id,
      permissionKey: { notIn: [...STORE_MANAGER_PERMISSION_KEYS] },
    },
  });
  for (const permissionKey of STORE_MANAGER_PERMISSION_KEYS) {
    await prisma.internalRolePermission.upsert({
      where: {
        roleId_permissionKey: { roleId: storeManagerRole.id, permissionKey },
      },
      update: {},
      create: { roleId: storeManagerRole.id, permissionKey },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });