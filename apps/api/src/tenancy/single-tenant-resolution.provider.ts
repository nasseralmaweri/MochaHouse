import type { Provider } from '@nestjs/common';
import {
  SINGLE_TENANT_ID_ENV,
  resolveSingleTenant,
  type SingleTenantResolution,
} from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';

export const SINGLE_TENANT_RESOLUTION = Symbol('SINGLE_TENANT_RESOLUTION');

// S0C — resolves SINGLE_TENANT_ID once, while the Nest application is being
// created. A missing, malformed or unknown id throws here, which aborts
// NestFactory.create — the API never starts serving without a valid tenant.
// There is no fallback value of any kind.
export const singleTenantResolutionProvider: Provider = {
  provide: SINGLE_TENANT_RESOLUTION,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService): Promise<SingleTenantResolution> =>
    resolveSingleTenant(process.env[SINGLE_TENANT_ID_ENV], (tenantId) =>
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true },
      }),
    ),
};
