import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { PlatformTenantsController } from './api/platform-tenants.controller';
import { PlatformTenantsService } from './application/platform-tenants.service';

// SC1c — the CENTERIVO tenant registry (/api/v1/platform/tenants*), read-only.
// Imports only the platform boundary (PlatformAuthGuard); nothing from the
// customer or tenant-staff auth modules. PrismaService is @Global.
@Module({
  imports: [PlatformAuthModule],
  controllers: [PlatformTenantsController],
  providers: [PlatformTenantsService],
})
export class PlatformTenantsModule {}
