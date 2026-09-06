import { Body, Get, Param, Post, Query, Req } from '@nestjs/common';
import type {
  ClearOpeningChecklistExceptionRequest,
  LogOpeningChecklistExceptionRequest,
  OpeningChecklistItemActionRequest,
} from '@mocha-house/contracts';
import { ChecklistExecutionService } from '../application/checklist-execution.service';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// The shared route surface for a daily checklist's store execution
// (Milestone 6B; Closing added in 6D). Opening and Closing controllers
// extend this and supply only their `ChecklistTemplate.key` — every line of
// workflow, projection, concurrency and Management Exception behaviour is
// identical and lives in ChecklistExecutionService.
//
//   GET     /<checklist>                          -> operations.view
//   POST    /<checklist>/items/:id/complete        -> operations.tasks.complete
//   POST    /<checklist>/items/:id/undo            -> operations.tasks.complete
//   POST    /<checklist>/items/:id/exception       -> operations.exceptions.manage
//   POST    /<checklist>/items/:id/exception/clear -> operations.exceptions.manage
//
// `locationId` (query on GET, body on the mutations) is a REQUIRED filter,
// never proof of authorization on its own. InternalAuthGuard +
// PermissionGuard are applied by each concrete @Controller.
export abstract class ChecklistExecutionControllerBase {
  protected abstract readonly templateKey: string;

  constructor(protected readonly service: ChecklistExecutionService) {}

  @RequirePermission('operations.view')
  @Get()
  getToday(
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getToday(
      this.templateKey,
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
    return this.service.completeItem(
      this.templateKey,
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
    return this.service.undoItem(
      this.templateKey,
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
    return this.service.logException(
      this.templateKey,
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
    return this.service.clearException(
      this.templateKey,
      instanceItemId,
      body?.locationId,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
