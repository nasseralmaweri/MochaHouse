import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { PlatformTenantsController } from './api/platform-tenants.controller';
import { PlatformTenantsService } from './application/platform-tenants.service';
import { TenantProvisioningService } from './application/tenant-provisioning.service';
import { RateLimitModule } from '../rate-limit/rate-limit.module';

// SC1c — the CENTERIVO tenant registry (/api/v1/platform/tenants*), read-only.
// SC1d — plus business provisioning (TenantProvisioningService: the only
// platform code that writes a business's own rows).
// Imports only the platform boundary (PlatformAuthGuard); nothing from the
// customer or tenant-staff auth modules. PrismaService is @Global.
@Module({
  imports: [PlatformAuthModule, RateLimitModule],
  controllers: [PlatformTenantsController],
  providers: [PlatformTenantsService, TenantProvisioningService],
})
export class PlatformTenantsModule {}
