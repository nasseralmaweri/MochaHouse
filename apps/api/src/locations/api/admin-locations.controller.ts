import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { LocationsService } from '../application/locations.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';

interface UpdateDigitalOrderingBody {
  isDigitalOrderingEnabled: boolean;
}

// Protected by InternalAuthGuard (Milestone 5A) — toggling a location's
// digital-ordering flag is an operational kill switch and must require an
// ACTIVE internal user. No Role/Permission/Scope checks yet (Milestone 5B).
@UseGuards(InternalAuthGuard)
@Controller('api/v1/admin/locations')
export class AdminLocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Patch(':locationId/digital-ordering')
  updateDigitalOrdering(
    @Param('locationId') locationId: string,
    @Body() body: UpdateDigitalOrderingBody,
  ) {
    return this.locationsService.updateDigitalOrdering(
      locationId,
      body.isDigitalOrderingEnabled,
    );
  }
}
