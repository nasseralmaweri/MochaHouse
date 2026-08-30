import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
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
  await prisma.internalUser.upsert({
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