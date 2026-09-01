import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { OpeningChecklistItemActionRequest } from '@mocha-house/contracts';
import { OpeningChecklistService } from '../application/opening-checklist.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// Admin → Operations → Today → Opening Checklist (Milestone 6B).
//
// Protected by InternalAuthGuard (authentication + ACTIVE lifecycle) then
// PermissionGuard (required permission + valid scope type). The service
// layer additionally enforces that the caller is authorized for the
// specific location, that the checklist item belongs to that location's
// instance, and that the instance is today's business date.
//
//   GET     /opening-checklist              -> operations.view
//   POST    /opening-checklist/items/:id/complete -> operations.tasks.complete
//   POST    /opening-checklist/items/:id/undo     -> operations.tasks.complete
//
// `locationId` (query on GET, body on the mutations) is a REQUIRED filter,
// never proof of authorization on its own.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/operations/opening-checklist')
export class OpeningChecklistController {
  constructor(
    private readonly openingChecklistService: OpeningChecklistService,
  ) {}

  @RequirePermission('operations.view')
  @Get()
  getToday(
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.openingChecklistService.getToday(
      locationId,
      request.authorization!,
    );
  }

  @RequirePermission('operations.tasks.complete')
  @Post('items/:instanceItemId/complete')
  completeItem(
    @Param('instanceItemId') instanceItemId: string,
    @Body() body: OpeningChecklistItemActionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.openingChecklistService.completeItem(
      instanceItemId,
      body?.locationId,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('operations.tasks.complete')
  @Post('items/:instanceItemId/undo')
  undoItem(
    @Param('instanceItemId') instanceItemId: string,
    @Body() body: OpeningChecklistItemActionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.openingChecklistService.undoItem(
      instanceItemId,
      body?.locationId,
      request.authorization!,
    );
  }
}
