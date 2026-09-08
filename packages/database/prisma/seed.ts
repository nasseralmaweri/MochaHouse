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
    // Milestone 6A — a Store Manager's home is the Store Operations
    // workspace for the locations they run. Held here as a LOCATION-scoped
    // capability (the role is only ever assigned per location).
    'operations.view',
    // Milestone 6B — a Store Manager runs the opening: completing (and
    // undoing) checklist items for their locations.
    'operations.tasks.complete',
    // Milestone 6C — a Store Manager is the person who logs a management
    // exception when an opening requirement genuinely could not be met.
    'operations.exceptions.manage',
    // Milestone 7F — gift-card administration (giftcards.view /
    // giftcards.manage / giftcards.configure) is deliberately NOT here. A
    // gift card is company-wide stored value; its administration is a
    // CORPORATE-only HQ function a Store Manager never holds by default.
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

  // Milestone 6B / 6D — the official corporate daily checklists (Opening
  // and Closing), seeded from the Mocha House Operations Manual. There is
  // ONE standard per checklist for every active location (no location
  // overrides). Every item starts isActive = true — only ACTIVE items are
  // copied into a newly created daily instance.
  //
  // SEED OWNERSHIP (Milestone 6B-2, applied to both checklists): HQ manages
  // these items through the Admin UI (wording, active state, ordering,
  // sections). The seed therefore SEEDS THEM ONCE — a brand-new database
  // receives the official standard below, and every subsequent seed run
  // leaves the items completely alone. HQ edits, HQ-added items and HQ
  // section changes survive reseeding; normal seed execution is NOT a reset
  // mechanism.
  const OPENING_CHECKLIST_ITEMS: {
    section: string;
    label: string;
  }[] = [
    // BUILDING & SECURITY
    { section: 'Building & Security', label: 'Unlock employee entrance and disarm security alarm.' },
    { section: 'Building & Security', label: 'Once inside, ensure entrance door is locked.' },
    { section: 'Building & Security', label: 'Turn on lights, music, tablets, and digital displays.' },
    { section: 'Building & Security', label: 'Walk through the store for safety hazards.' },
    { section: 'Building & Security', label: 'Inspect entrances, exits, and parking lot for cleanliness.' },
    // EQUIPMENT
    { section: 'Equipment', label: 'Turn on espresso machine and allow warm-up.' },
    { section: 'Equipment', label: 'Turn on grinders and verify operation.' },
    { section: 'Equipment', label: 'Power ovens, blenders, ice machines, brewers, and refrigeration.' },
    { section: 'Equipment', label: 'Verify hot water and refrigeration are operating correctly.' },
    // COFFEE & BEVERAGE PREPARATION
    { section: 'Coffee & Beverage Preparation', label: 'Brew fresh drip coffee.' },
    { section: 'Coffee & Beverage Preparation', label: 'Calibrate espresso grinder and pull test shot.' },
    { section: 'Coffee & Beverage Preparation', label: 'Prepare iced coffee, cold brew, and daily beverage components.' },
    { section: 'Coffee & Beverage Preparation', label: 'Fill ice bins.' },
    // FOOD PREPARATION & STOCKING
    { section: 'Food Preparation & Stocking', label: 'Prepare and stock pastry display.' },
    { section: 'Food Preparation & Stocking', label: 'Restock sandwiches, desserts, and grab-and-go items.' },
    { section: 'Food Preparation & Stocking', label: 'Verify food products are within expiration dates and properly labeled.' },
    { section: 'Food Preparation & Stocking', label: 'Refill essential service and beverage supplies.' },
    // CASH & POS
    { section: 'Cash & POS', label: 'Log into POS and verify functionality.' },
    { section: 'Cash & POS', label: 'Count and verify opening cash drawer according to policy.' },
    { section: 'Cash & POS', label: 'Test receipt printers, payment terminals, and kitchen printers.' },
    // FINAL READINESS
    { section: 'Final Readiness', label: 'Verify menu boards and promotional displays.' },
    { section: 'Final Readiness', label: 'Verify drive-thru speaker, headset, and outside menu are operational.' },
    { section: 'Final Readiness', label: 'Unlock front doors only when fully prepared.' },
  ];

  // The official 14-item Closing Checklist (Milestone 6D).
  const CLOSING_CHECKLIST_ITEMS: {
    section: string;
    label: string;
  }[] = [
    // END-OF-SHIFT & CLEANING
    { section: 'End-of-Shift & Cleaning', label: 'Properly store all perishable food items using FIFO.' },
    { section: 'End-of-Shift & Cleaning', label: 'Clean and sanitize all counters, tables, chairs, and workstations.' },
    { section: 'End-of-Shift & Cleaning', label: 'Thoroughly sweep and mop all floors, including lobby, work area, and back area.' },
    { section: 'End-of-Shift & Cleaning', label: 'Deep-clean the espresso machine, including group heads and steam wands.' },
    { section: 'End-of-Shift & Cleaning', label: 'Clean blenders, rinse pitchers, and sanitize tea/coffee brewing equipment.' },
    { section: 'End-of-Shift & Cleaning', label: 'Prepare next-day sandwiches.' },
    { section: 'End-of-Shift & Cleaning', label: 'Restock all stations for the morning shift.' },
    // CASH HANDLING & SECURITY
    { section: 'Cash Handling & Security', label: 'Perform final POS end-of-day reconciliation.' },
    { section: 'Cash Handling & Security', label: 'Count and secure cash in the safe according to company protocols.' },
    { section: 'Cash Handling & Security', label: 'Verify the required cash float is maintained according to store policy.' },
    // BUILDING & FINAL CLOSE
    { section: 'Building & Final Close', label: 'Empty all trash and replace liners.' },
    { section: 'Building & Final Close', label: 'Restock restrooms and ensure they are clean.' },
    { section: 'Building & Final Close', label: 'Turn off unnecessary equipment, including ovens, blenders, brewers, and displays.' },
    { section: 'Building & Final Close', label: 'Perform a final security walk-through, lock all doors, and set the alarm.' },
  ];

  // Create-once for each checklist: upsert the template row, then populate
  // the standard items ONLY when the template has none. Once items exist
  // they are HQ-managed and the seed never touches them again (no delete,
  // no re-create, no wording/order/active overwrite).
  async function seedChecklist(
    key: string,
    name: string,
    items: { section: string; label: string }[],
  ): Promise<void> {
    const template = await prisma.checklistTemplate.upsert({
      where: { key },
      update: { name, isActive: true },
      create: { key, name, isActive: true },
    });
    const existingItemCount = await prisma.checklistTemplateItem.count({
      where: { templateId: template.id },
    });
    if (existingItemCount === 0) {
      await prisma.checklistTemplateItem.createMany({
        data: items.map((item, index) => ({
          templateId: template.id,
          section: item.section,
          label: item.label,
          sortOrder: index + 1,
          isActive: true,
        })),
      });
    }
  }

  await seedChecklist('opening', 'Opening Checklist', OPENING_CHECKLIST_ITEMS);
  await seedChecklist('closing', 'Closing Checklist', CLOSING_CHECKLIST_ITEMS);

  // Milestone 7B — the single company-wide loyalty configuration (keyed
  // singleton). Create-once at the default rate of 1 Mocha Bean per
  // qualifying dollar, which preserves the 7A behaviour exactly; re-seeding
  // never overwrites an HQ-chosen rate. The Rewards Catalog is NOT seeded —
  // HQ creates rewards through the Admin UI.
  await prisma.loyaltyConfiguration.upsert({
    where: { key: 'company' },
    update: {},
    create: { key: 'company', earningRatePerDollar: 1 },
  });

  // Milestone 7F — the single company-wide gift-card purchasing
  // configuration (keyed singleton). Persisted now so the FUTURE
  // customer-purchasing slice has HQ settings to read; nothing in 7F
  // consumes it. Create-once with example preset amounts ($10 / $25 / $50 /
  // $100 in integer minor units) and custom amounts enabled; re-seeding
  // never overwrites HQ-chosen values. Gift cards themselves are NOT
  // seeded — HQ issues them through the Admin UI.
  await prisma.giftCardConfiguration.upsert({
    where: { key: 'company' },
    update: {},
    create: {
      key: 'company',
      presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
      customAmountEnabled: true,
    },
  });
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