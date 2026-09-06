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
import type {
  ClearOpeningChecklistExceptionRequest,
  LogOpeningChecklistExceptionRequest,
  OpeningChecklistItemActionRequest,
} from '@mocha-house/contracts';
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
//   GET     /opening-checklist                         -> operations.view
//   POST    /opening-checklist/items/:id/complete       -> operations.tasks.complete
//   POST    /opening-checklist/items/:id/undo           -> operations.tasks.complete
//   POST    /opening-checklist/items/:id/exception       -> operations.exceptions.manage
//   POST    /opening-checklist/items/:id/exception/clear -> operations.exceptions.manage
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

  // --- Management Exception (Milestone 6C) ---------------------------
  // Separate permission from Complete/Undo: waiving a standard requirement
  // is a management decision, and it is audited.
  @RequirePermission('operations.exceptions.manage')
  @Post('items/:instanceItemId/exception')
  logException(
    @Param('instanceItemId') instanceItemId: string,
    @Body() body: LogOpeningChecklistExceptionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.openingChecklistService.logException(
      instanceItemId,
      body?.locationId,
      body?.reason,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('operations.exceptions.manage')
  @Post('items/:instanceItemId/exception/clear')
  clearException(
    @Param('instanceItemId') instanceItemId: string,
    @Body() body: ClearOpeningChecklistExceptionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.openingChecklistService.clearException(
      instanceItemId,
      body?.locationId,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
