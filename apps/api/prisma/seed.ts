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