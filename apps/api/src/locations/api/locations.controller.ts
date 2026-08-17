import { Controller, Get, Param } from '@nestjs/common';
import { LocationsService } from '../application/locations.service';

@Controller('api/v1/locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get()
  findAll() {
    return this.locationsService.findAll();
  }

  @Get(':locationId/menu')
  findMenu(@Param('locationId') locationId: string) {
    return this.locationsService.findMenu(locationId);
  }
}