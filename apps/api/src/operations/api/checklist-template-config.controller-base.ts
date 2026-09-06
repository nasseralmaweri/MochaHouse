import { Body, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type {
  AddOpeningChecklistTemplateItemRequest,
  MoveOpeningChecklistTemplateItemRequest,
  MoveOpeningChecklistTemplateSectionRequest,
  RenameOpeningChecklistTemplateSectionRequest,
  UpdateOpeningChecklistTemplateItemRequest,
} from '@mocha-house/contracts';
import { ChecklistTemplateConfigService } from '../application/checklist-template-config.service';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// The shared route surface for HQ configuration of a daily-checklist
// template (Milestone 6B-2; Closing added in 6D). Opening and Closing
// config controllers extend this and supply only their
// `ChecklistTemplate.key`.
//
// Every route requires `operations.checklists.configure`, CORPORATE-only in
// the permission catalog — a location-scoped grant can never satisfy it,
// and the service re-asserts corporate scope. No route accepts a
// `locationId`: there is one corporate standard per checklist, no
// per-location override.
//
// Mutations return the whole authoritative template projection so the UI
// reconciles from it (the same contract as the execution routes).
// InternalAuthGuard + PermissionGuard are applied by each concrete
// @Controller.
export abstract class ChecklistTemplateConfigControllerBase {
  protected abstract readonly templateKey: string;

  constructor(protected readonly service: ChecklistTemplateConfigService) {}

  @RequirePermission('operations.checklists.configure')
  @Get()
  getConfig(@Req() request: InternalAuthenticatedRequest) {
    return this.service.getConfig(this.templateKey, request.authorization!);
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
      this.templateKey,
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
      this.templateKey,
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
      this.templateKey,
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
      this.templateKey,
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
      this.templateKey,
      { section: body?.section, direction: body?.direction },
      request.authorization!,
    );
  }
}
