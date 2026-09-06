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
  CreateOperationsTaskRequest,
  OperationsTaskActionRequest,
} from '@mocha-house/contracts';
import { OperationsTasksService } from '../application/operations-tasks.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// Admin → Operations → Today → Today's Tasks (Milestone 6C).
//
// InternalAuthGuard (authentication + ACTIVE) then PermissionGuard. The
// service additionally enforces that the caller is authorized for the
// specific location, that the task belongs to that location, and that it
// belongs to TODAY's business date (no rollover).
//
//   GET     /tasks                  -> operations.view
//   POST    /tasks                  -> operations.tasks.complete
//   POST    /tasks/:taskId/complete -> operations.tasks.complete
//   POST    /tasks/:taskId/reopen   -> operations.tasks.complete
//   POST    /tasks/:taskId/delete   -> operations.tasks.complete
//
// `locationId` (query on GET, body on the mutations) is a REQUIRED filter,
// never proof of authorization on its own. Delete is a POST (not HTTP
// DELETE) so the internal proxy forwards its body unchanged.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/operations/tasks')
export class OperationsTasksController {
  constructor(private readonly tasksService: OperationsTasksService) {}

  @RequirePermission('operations.view')
  @Get()
  list(
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.tasksService.list(locationId, request.authorization!);
  }

  @RequirePermission('operations.tasks.complete')
  @Post()
  create(
    @Body() body: CreateOperationsTaskRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.tasksService.create(
      body?.locationId,
      { title: body?.title, note: body?.note },
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('operations.tasks.complete')
  @Post(':taskId/complete')
  complete(
    @Param('taskId') taskId: string,
    @Body() body: OperationsTaskActionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.tasksService.complete(
      taskId,
      body?.locationId,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('operations.tasks.complete')
  @Post(':taskId/reopen')
  reopen(
    @Param('taskId') taskId: string,
    @Body() body: OperationsTaskActionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.tasksService.reopen(
      taskId,
      body?.locationId,
      request.authorization!,
    );
  }

  @RequirePermission('operations.tasks.complete')
  @Post(':taskId/delete')
  remove(
    @Param('taskId') taskId: string,
    @Body() body: OperationsTaskActionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.tasksService.remove(
      taskId,
      body?.locationId,
      request.authorization!,
    );
  }
}
