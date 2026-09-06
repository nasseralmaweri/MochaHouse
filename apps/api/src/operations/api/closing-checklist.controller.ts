import { Controller, UseGuards } from '@nestjs/common';
import {
  ChecklistExecutionService,
  CLOSING_TEMPLATE_KEY,
} from '../application/checklist-execution.service';
import { ChecklistExecutionControllerBase } from './checklist-execution.controller-base';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';

// Admin → Operations → Today → Closing Checklist (Milestone 6D). Identical
// to the Opening Checklist controller — same base, same permissions, same
// Management Exception behaviour — bound to the `closing` template and the
// `/closing-checklist` path.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/operations/closing-checklist')
export class ClosingChecklistController extends ChecklistExecutionControllerBase {
  protected readonly templateKey = CLOSING_TEMPLATE_KEY;

  constructor(service: ChecklistExecutionService) {
    super(service);
  }
}
