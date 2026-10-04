import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AdminUpdateLocationRequest } from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { LocationsService } from '../application/locations.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';

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

  // --- Admin read experience (Milestone 5D-1) -----------------------
  // `locations.view` is valid at CORPORATE or LOCATION scope. The list is
  // scope-filtered in the service from `request.authorization`; the detail
  // route calls `assertCanActOnLocation` before the row is read, so a
  // cross-location request is a 403 and never leaks through a 404.
  @RequirePermission('locations.view')
  @Get()
  listLocations(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.locationsService.listAdminLocations(
      request.authorization!,
      tenant,
    );
  }

  @RequirePermission('locations.view')
  @Get(':locationId')
  getLocation(
    @Param('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.locationsService.getAdminLocationDetail(
      locationId,
      request.authorization!,
      tenant,
    );
  }

  // --- Minimal edit (Milestone 5D-2) -------------------------------
  // A CORPORATE-only edit (`locations.edit`), deliberately separate from
  // the digital-ordering control below — different permission, different
  // scope model. Only `name` and `isActive` are read from the body; `slug`
  // and every other field are ignored, so they cannot be changed here.
  @RequirePermission('locations.edit')
  @Patch(':locationId')
  updateLocation(
    @Param('locationId') locationId: string,
    @Body() body: AdminUpdateLocationRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.locationsService.updateLocation(
      locationId,
      { name: body.name, isActive: body.isActive },
      request.authorization!,
      tenant,
    );
  }

  @RequirePermission('locations.manage_digital_ordering')
  @Patch(':locationId/digital-ordering')
  updateDigitalOrdering(
    @Param('locationId') locationId: string,
    @Body() body: UpdateDigitalOrderingBody,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.locationsService.updateDigitalOrdering(
      locationId,
      body.isDigitalOrderingEnabled,
      request.authorization!,
      tenant,
    );
  }
}
