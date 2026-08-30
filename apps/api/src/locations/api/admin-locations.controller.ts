import { Body, Controller, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { LocationsService } from '../application/locations.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

interface UpdateDigitalOrderingBody {
  isDigitalOrderingEnabled: boolean;
}

// InternalAuthGuard (authentication + ACTIVE) then PermissionGuard
// (Milestone 5B). `locations.manage_digital_ordering` is valid at CORPORATE
// or LOCATION scope; the service verifies the caller is authorized for the
// specific `:locationId` and that the location exists.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/locations')
export class AdminLocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @RequirePermission('locations.manage_digital_ordering')
  @Patch(':locationId/digital-ordering')
  updateDigitalOrdering(
    @Param('locationId') locationId: string,
    @Body() body: UpdateDigitalOrderingBody,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.locationsService.updateDigitalOrdering(
      locationId,
      body.isDigitalOrderingEnabled,
      request.authorization!,
    );
  }
}
