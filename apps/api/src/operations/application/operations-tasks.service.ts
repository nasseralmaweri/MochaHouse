import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  OperationsTaskView,
  OperationsTasksResponse,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  businessDateToProjection,
  businessDateToStorage,
  resolveBusinessDate,
} from './business-date';

const TITLE_MAX_LENGTH = 200;
const NOTE_MAX_LENGTH = 500;

const TASK_SELECT = {
  id: true,
  title: true,
  note: true,
  completedAt: true,
  createdAt: true,
  completedBy: { select: { displayName: true, email: true } },
  createdBy: { select: { displayName: true, email: true } },
} satisfies Prisma.OperationsTaskSelect;

type TaskRow = Prisma.OperationsTaskGetPayload<{ select: typeof TASK_SELECT }>;

interface LocationRef {
  id: string;
  name: string;
}

// Today's Tasks (Milestone 6C). Simple, location-scoped operational to-dos
// for ONE America/Detroit business date.
//
//   GET     — `operations.view` for the location. Lists TODAY's tasks
//             (open first, then done; oldest first within each group).
//   Add / Complete / Reopen / Delete — `operations.tasks.complete` for the
//             location. A task can only be acted on for the business date
//             it belongs to: yesterday's tasks simply don't appear today
//             and can't be mutated (there is no rollover).
//
// Not an audit surface — routine task actions are not recorded in
// InternalAuditEvent. Complete/Reopen use conditional writes so concurrent
// requests are idempotent; there is no cross-row aggregate to lock.
@Injectable()
export class OperationsTasksService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<OperationsTasksResponse> {
    const trimmedLocationId = assertLocationId(locationId);
    authorization.assertCanActOnLocation('operations.view', trimmedLocationId);

    const location = await this.requireLocation(trimmedLocationId);
    return this.projectList(trimmedLocationId, location);
  }

  async create(
    locationId: string,
    input: { title?: unknown; note?: unknown },
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<OperationsTasksResponse> {
    const trimmedLocationId = assertLocationId(locationId);
    authorization.assertCanActOnLocation(
      'operations.tasks.complete',
      trimmedLocationId,
    );

    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      throw new BadRequestException('A task title is required.');
    }
    const title = input.title.trim();
    if (title.length > TITLE_MAX_LENGTH) {
      throw new BadRequestException(
        `A task title must be ${TITLE_MAX_LENGTH} characters or fewer.`,
      );
    }

    let note: string | null = null;
    if (input.note !== undefined && input.note !== null) {
      if (typeof input.note !== 'string') {
        throw new BadRequestException('A task note must be text.');
      }
      const trimmedNote = input.note.trim();
      if (trimmedNote.length > NOTE_MAX_LENGTH) {
        throw new BadRequestException(
          `A task note must be ${NOTE_MAX_LENGTH} characters or fewer.`,
        );
      }
      note = trimmedNote.length > 0 ? trimmedNote : null;
    }

    const location = await this.requireLocation(trimmedLocationId);

    await this.prisma.operationsTask.create({
      data: {
        locationId: trimmedLocationId,
        businessDate: this.today(),
        title,
        note,
        createdByInternalUserId: actorInternalUserId,
      },
    });

    return this.projectList(trimmedLocationId, location);
  }

  async complete(
    taskId: string,
    locationId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<OperationsTasksResponse> {
    return this.mutate(taskId, locationId, authorization, (trimmedTaskId) =>
      // Conditional: Complete only wins when the task is currently open.
      // A repeat request is an idempotent no-op — the winning actor/time
      // is left untouched.
      this.prisma.operationsTask.updateMany({
        where: { id: trimmedTaskId, completedAt: null },
        data: {
          completedAt: new Date(),
          completedByInternalUserId: actorInternalUserId,
        },
      }),
    );
  }

  async reopen(
    taskId: string,
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<OperationsTasksResponse> {
    return this.mutate(taskId, locationId, authorization, (trimmedTaskId) =>
      this.prisma.operationsTask.updateMany({
        where: { id: trimmedTaskId, completedAt: { not: null } },
        data: { completedAt: null, completedByInternalUserId: null },
      }),
    );
  }

  async remove(
    taskId: string,
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<OperationsTasksResponse> {
    return this.mutate(taskId, locationId, authorization, (trimmedTaskId) =>
      // Hard delete — approved for a mistaken same-day task. Scoped by id +
      // location + today so it can never reach another location's or a
      // prior day's task.
      this.prisma.operationsTask.deleteMany({ where: { id: trimmedTaskId } }),
    );
  }

  // --- internals ----------------------------------------------------

  private async mutate(
    taskId: string,
    locationId: string,
    authorization: AuthorizationContext,
    write: (taskId: string) => Promise<unknown>,
  ): Promise<OperationsTasksResponse> {
    const trimmedLocationId = assertLocationId(locationId);
    authorization.assertCanActOnLocation(
      'operations.tasks.complete',
      trimmedLocationId,
    );

    const trimmedTaskId = assertTaskId(taskId);
    const task = await this.prisma.operationsTask.findUnique({
      where: { id: trimmedTaskId },
      select: { locationId: true, businessDate: true },
    });
    if (
      !task ||
      task.locationId !== trimmedLocationId ||
      task.businessDate.getTime() !== this.today().getTime()
    ) {
      // One response for "no such task", "another location's task" and "a
      // prior business date" — a location-scoped caller must not tell them
      // apart (same principle as the checklist item check).
      throw new NotFoundException('Task not found for this location.');
    }

    await write(trimmedTaskId);

    const location = await this.requireLocation(trimmedLocationId);
    return this.projectList(trimmedLocationId, location);
  }

  private today(): Date {
    return businessDateToStorage(resolveBusinessDate(new Date()));
  }

  private async projectList(
    locationId: string,
    location: LocationRef,
  ): Promise<OperationsTasksResponse> {
    const businessDate = this.today();
    const tasks = await this.prisma.operationsTask.findMany({
      where: { locationId, businessDate },
      orderBy: { createdAt: 'asc' },
      select: TASK_SELECT,
    });

    const views = tasks.map(projectTask);
    // Open first, then done — stable within each group (already oldest-first).
    views.sort((a, b) => Number(a.done) - Number(b.done));

    return {
      locationId: location.id,
      locationName: location.name,
      businessDate: businessDateToProjection(businessDate),
      tasks: views,
      openCount: views.filter((t) => !t.done).length,
      doneCount: views.filter((t) => t.done).length,
    };
  }

  private async requireLocation(locationId: string): Promise<LocationRef> {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, name: true },
    });
    if (!location) {
      throw new NotFoundException('Location not found.');
    }
    return location;
  }
}

function assertLocationId(locationId: unknown): string {
  if (typeof locationId !== 'string' || locationId.trim().length === 0) {
    throw new BadRequestException('locationId is required.');
  }
  return locationId.trim();
}

function assertTaskId(taskId: unknown): string {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new NotFoundException('Task not found for this location.');
  }
  return taskId.trim();
}

function projectTask(task: TaskRow): OperationsTaskView {
  const completedName =
    task.completedBy?.displayName ?? task.completedBy?.email ?? null;
  const createdName =
    task.createdBy?.displayName ?? task.createdBy?.email ?? null;
  return {
    id: task.id,
    title: task.title,
    note: task.note,
    done: task.completedAt !== null,
    completedBy: completedName ? { name: completedName } : null,
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    createdBy: createdName ? { name: createdName } : null,
    createdAt: task.createdAt.toISOString(),
  };
}
