import { Body, Controller, Param, Patch } from '@nestjs/common';
import { LocationsService } from '../application/locations.service';

interface UpdateDigitalOrderingBody {
  isDigitalOrderingEnabled: boolean;
}

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