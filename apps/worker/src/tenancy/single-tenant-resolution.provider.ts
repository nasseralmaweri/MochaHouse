import type { Provider } from '@nestjs/common';
import {
  SINGLE_TENANT_ID_ENV,
  resolveSingleTenant,
  type SingleTenantResolution,
} from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';

export const SINGLE_TENANT_RESOLUTION = Symbol('SINGLE_TENANT_RESOLUTION');

// S0C — the worker validates SINGLE_TENANT_ID at startup exactly like the
// API: missing, malformed or unknown aborts NestFactory.create. No fallback.
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
