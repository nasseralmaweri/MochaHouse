import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AddOpeningChecklistTemplateItemRequest,
  MoveOpeningChecklistTemplateItemRequest,
  MoveOpeningChecklistTemplateSectionRequest,
  RenameOpeningChecklistTemplateSectionRequest,
  UpdateOpeningChecklistTemplateItemRequest,
} from '@mocha-house/contracts';
import { ChecklistTemplateConfigService } from '../application/checklist-template-config.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// Admin → Operations → Opening Checklist → Configuration (Milestone 6B-2).
// HQ management of the ONE corporate Opening Checklist template.
//
// InternalAuthGuard (authentication + ACTIVE) then PermissionGuard. Every
// route requires `operations.checklists.configure`, which is CORPORATE-only
// in the permission catalog — a location-scoped grant can never satisfy it,
// and the service re-asserts corporate scope. No route accepts a
// `locationId`: there is one corporate standard, no per-location override.
//
// Mutations return the whole authoritative template projection so the UI
// reconciles from it (the same contract as the 6B execution routes).
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/operations/opening-checklist/template')
export class ChecklistTemplateConfigController {
  constructor(private readonly service: ChecklistTemplateConfigService) {}

  @RequirePermission('operations.checklists.configure')
  @Get()
  getConfig(@Req() request: InternalAuthenticatedRequest) {
    return this.service.getConfig(request.authorization!);
  }

  @RequirePermission('operations.checklists.configure')
  @Patch('items/:itemId')
  updateItem(
    @Param('itemId') itemId: string,
    @Body() body: UpdateOpeningChecklistTemplateItemRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    // Explicit fields only — the body is never spread into the service.
    return this.service.updateItem(
      itemId,
      { label: body?.label, isActive: body?.isActive },
      request.authorization!,
    );
  }

  @RequirePermission('operations.checklists.configure')
  @Post('items')
  addItem(
    @Body() body: AddOpeningChecklistTemplateItemRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.addItem(
      { section: body?.section, label: body?.label },
      request.authorization!,
    );
  }

  @RequirePermission('operations.checklists.configure')
  @Post('items/:itemId/move')
  moveItem(
    @Param('itemId') itemId: string,
    @Body() body: MoveOpeningChecklistTemplateItemRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.moveItem(
      itemId,
      body?.direction,
      request.authorization!,
    );
  }

  @RequirePermission('operations.checklists.configure')
  @Post('sections/rename')
  renameSection(
    @Body() body: RenameOpeningChecklistTemplateSectionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.renameSection(
      { from: body?.from, to: body?.to },
      request.authorization!,
    );
  }

  @RequirePermission('operations.checklists.configure')
  @Post('sections/move')
  moveSection(
    @Body() body: MoveOpeningChecklistTemplateSectionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.moveSection(
      { section: body?.section, direction: body?.direction },
      request.authorization!,
    );
  }
}
