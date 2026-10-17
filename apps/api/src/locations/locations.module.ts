import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AuditModule } from '../audit/audit.module';
import { AdminLocationsController } from './api/admin-locations.controller';
import { AdminGettingStartedController } from './api/admin-getting-started.controller';
import { LocationsController } from './api/locations.controller';
import { LocationsService } from './application/locations.service';
import { LocationSetupService } from './application/location-setup.service';
import { GettingStartedService } from './application/getting-started.service';

@Module({
  imports: [PrismaModule, TenancyModule, AuditModule],
  controllers: [
    LocationsController,
    AdminLocationsController,
    AdminGettingStartedController,
  ],
  providers: [LocationsService, LocationSetupService, GettingStartedService],
  exports: [LocationsService],
})
export class LocationsModule {}
