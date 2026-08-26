import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminLocationsController } from './api/admin-locations.controller';
import { LocationsController } from './api/locations.controller';
import { LocationsService } from './application/locations.service';

@Module({
  imports: [PrismaModule],
  controllers: [LocationsController, AdminLocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
