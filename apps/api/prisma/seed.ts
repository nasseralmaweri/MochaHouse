import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const location = await prisma.location.upsert({
    where: {
      slug: 'dearborn-heights',
    },
    update: {},
    create: {
      name: 'Mocha House - Dearborn Heights',
      slug: 'dearborn-heights',
      isActive: true,
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