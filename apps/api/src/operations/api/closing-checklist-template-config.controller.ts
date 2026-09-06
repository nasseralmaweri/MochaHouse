import { Controller, UseGuards } from '@nestjs/common';
import { CLOSING_TEMPLATE_KEY } from '../application/checklist-execution.service';
import { ChecklistTemplateConfigService } from '../application/checklist-template-config.service';
import { ChecklistTemplateConfigControllerBase } from './checklist-template-config.controller-base';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';

// Admin → Operations → Closing Checklist → Configuration (Milestone 6D).
// Identical to the Opening config controller — same base, same
// `operations.checklists.configure` permission — bound to the `closing`
// template and the `/closing-checklist/template` path.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/operations/closing-checklist/template')
export class ClosingChecklistTemplateConfigController extends ChecklistTemplateConfigControllerBase {
  protected readonly templateKey = CLOSING_TEMPLATE_KEY;

  constructor(service: ChecklistTemplateConfigService) {
    super(service);
  }
}
