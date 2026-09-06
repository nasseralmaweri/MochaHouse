import { Controller, UseGuards } from '@nestjs/common';
import { OPENING_TEMPLATE_KEY } from '../application/checklist-execution.service';
import { ChecklistTemplateConfigService } from '../application/checklist-template-config.service';
import { ChecklistTemplateConfigControllerBase } from './checklist-template-config.controller-base';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';

// Admin → Operations → Opening Checklist → Configuration (Milestone 6B-2).
// Binds the shared config route surface to the `opening` template and the
// `/opening-checklist/template` path (unchanged from 6B-2/6C).
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/operations/opening-checklist/template')
export class OpeningChecklistTemplateConfigController extends ChecklistTemplateConfigControllerBase {
  protected readonly templateKey = OPENING_TEMPLATE_KEY;

  constructor(service: ChecklistTemplateConfigService) {
    super(service);
  }
}
