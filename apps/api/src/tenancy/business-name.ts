import type { PrismaService } from '../prisma/prisma.service';

// Security 4A — a business's display name for tenant-facing text (emails,
// consent wording, default content, report definitions), read from the
// business's own Tenant row. Shared code never hardcodes a brand: Mocha
// House's wording comes out unchanged because its Tenant.name is
// "Mocha House", and no other business can ever be shown that name.
export async function businessDisplayName(
  prisma: Pick<PrismaService, 'tenant'>,
  tenantId: string,
): Promise<string> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true },
  });
  return tenant.name.trim();
}
