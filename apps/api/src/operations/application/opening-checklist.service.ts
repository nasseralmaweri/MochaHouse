import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  OpeningChecklistResponse,
  OpeningChecklistSectionView,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  businessDateToProjection,
  businessDateToStorage,
  resolveBusinessDate,
} from './business-date';

const OPENING_TEMPLATE_KEY = 'opening';

const INSTANCE_INCLUDE = {
  items: {
    orderBy: { sortOrder: 'asc' },
    include: {
      completedBy: { select: { displayName: true, email: true } },
    },
  },
} satisfies Prisma.ChecklistInstanceInclude;

type InstanceWithItems = Prisma.ChecklistInstanceGetPayload<{
  include: typeof INSTANCE_INCLUDE;
}>;

interface LocationRef {
  id: string;
  name: string;
}

// The Opening Checklist workflow (Milestone 6B). The first real Store
// Operations write surface.
//
//   GET     — authorize the location, resolve today's business date
//             (America/Detroit), find-or-create the instance (snapshotting
//             the ACTIVE template items on creation), project it.
//   Complete/Undo — authorize the location, verify the item belongs to
//             THIS location's instance for TODAY, flip exactly one item
//             with a conditional update, recompute instance completion,
//             then reconcile the whole projection from the database.
//
// Historical safety: an instance's item rows are a by-value snapshot taken
// at creation. Nothing here re-reads ChecklistTemplateItem for an existing
// instance, so later template edits never rewrite history.
@Injectable()
export class OpeningChecklistService {
  constructor(private readonly prisma: PrismaService) {}

  async getToday(
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistResponse> {
    const trimmedLocationId = assertLocationId(locationId);
    authorization.assertCanActOnLocation('operations.view', trimmedLocationId);

    const location = await this.requireLocation(trimmedLocationId);
    const template = await this.requireOpeningTemplate();

    const businessDate = businessDateToStorage(resolveBusinessDate(new Date()));
    const instance = await this.findOrCreateInstance(
      template.id,
      trimmedLocationId,
      businessDate,
    );

    return this.project(instance, location, template.name);
  }

  async completeItem(
    instanceItemId: string,
    locationId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistResponse> {
    const trimmedLocationId = assertLocationId(locationId);
    authorization.assertCanActOnLocation(
      'operations.tasks.complete',
      trimmedLocationId,
    );

    const context = await this.loadItemContext(
      instanceItemId,
      trimmedLocationId,
    );

    await this.prisma.$transaction(async (tx) => {
      await lockInstance(tx, context.instanceId);
      // Conditional update: Complete only wins when the item is currently
      // incomplete. If another request already completed it, count === 0
      // and this is an idempotent no-op — the actor/timestamp already
      // recorded by the winning request are left untouched.
      await tx.checklistInstanceItem.updateMany({
        where: { id: instanceItemId, completedAt: null },
        data: {
          completedAt: new Date(),
          completedByInternalUserId: actorInternalUserId,
        },
      });
      await recomputeInstanceCompletion(tx, context.instanceId);
    });

    return this.reload(context.instanceId, context.location, context.title);
  }

  async undoItem(
    instanceItemId: string,
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistResponse> {
    const trimmedLocationId = assertLocationId(locationId);
    authorization.assertCanActOnLocation(
      'operations.tasks.complete',
      trimmedLocationId,
    );

    const context = await this.loadItemContext(
      instanceItemId,
      trimmedLocationId,
    );

    await this.prisma.$transaction(async (tx) => {
      await lockInstance(tx, context.instanceId);
      // Undo only wins when the item is currently completed. Otherwise an
      // idempotent no-op. actor + timestamp are always cleared together.
      await tx.checklistInstanceItem.updateMany({
        where: { id: instanceItemId, completedAt: { not: null } },
        data: { completedAt: null, completedByInternalUserId: null },
      });
      // If the instance had been marked complete, this clears it — the
      // checklist is no longer complete.
      await recomputeInstanceCompletion(tx, context.instanceId);
    });

    return this.reload(context.instanceId, context.location, context.title);
  }

  // --- find-or-create -------------------------------------------------

  private async findOrCreateInstance(
    templateId: string,
    locationId: string,
    businessDate: Date,
  ): Promise<InstanceWithItems> {
    const existing = await this.prisma.checklistInstance.findUnique({
      where: {
        templateId_locationId_businessDate: {
          templateId,
          locationId,
          businessDate,
        },
      },
      include: INSTANCE_INCLUDE,
    });
    if (existing) {
      return existing;
    }

    try {
      // Instance + its item snapshot are created atomically, so a
      // partially populated instance is never visible.
      return await this.prisma.$transaction(async (tx) => {
        const activeItems = await tx.checklistTemplateItem.findMany({
          where: { templateId, isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { section: true, label: true, sortOrder: true },
        });

        return tx.checklistInstance.create({
          data: {
            templateId,
            locationId,
            businessDate,
            items: {
              create: activeItems.map((item) => ({
                section: item.section,
                label: item.label,
                sortOrder: item.sortOrder,
              })),
            },
          },
          include: INSTANCE_INCLUDE,
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Lost the create race against a concurrent first GET for the same
        // location/business date. The unique constraint held — re-read the
        // winning instance and return that, so both callers see one
        // authoritative checklist.
        return this.prisma.checklistInstance.findUniqueOrThrow({
          where: {
            templateId_locationId_businessDate: {
              templateId,
              locationId,
              businessDate,
            },
          },
          include: INSTANCE_INCLUDE,
        });
      }
      throw error;
    }
  }

  // --- item resource resolution --------------------------------------

  private async loadItemContext(
    instanceItemId: string,
    locationId: string,
  ): Promise<{ instanceId: string; location: LocationRef; title: string }> {
    if (
      typeof instanceItemId !== 'string' ||
      instanceItemId.trim().length === 0
    ) {
      throw new NotFoundException('Checklist item not found for this location.');
    }

    const item = await this.prisma.checklistInstanceItem.findUnique({
      where: { id: instanceItemId },
      select: {
        checklistInstance: {
          select: {
            id: true,
            locationId: true,
            businessDate: true,
            template: { select: { name: true } },
            location: { select: { id: true, name: true } },
          },
        },
      },
    });

    const today = businessDateToStorage(resolveBusinessDate(new Date()));

    if (
      !item ||
      item.checklistInstance.locationId !== locationId ||
      item.checklistInstance.businessDate.getTime() !== today.getTime()
    ) {
      // One response for "no such item", "another location's item" and
      // "a prior business date" — a location-scoped caller must not be able
      // to tell them apart (same principle as the order-detail check).
      throw new NotFoundException('Checklist item not found for this location.');
    }

    return {
      instanceId: item.checklistInstance.id,
      location: item.checklistInstance.location,
      title: item.checklistInstance.template.name,
    };
  }

  // --- projection ---------------------------------------------------

  private async reload(
    instanceId: string,
    location: LocationRef,
    title: string,
  ): Promise<OpeningChecklistResponse> {
    const instance = await this.prisma.checklistInstance.findUniqueOrThrow({
      where: { id: instanceId },
      include: INSTANCE_INCLUDE,
    });
    return this.project(instance, location, title);
  }

  private project(
    instance: InstanceWithItems,
    location: LocationRef,
    title: string,
  ): OpeningChecklistResponse {
    const items = [...instance.items].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const total = items.length;
    const completed = items.filter((item) => item.completedAt !== null).length;

    const sections: OpeningChecklistSectionView[] = [];
    const byName = new Map<string, OpeningChecklistSectionView>();
    for (const item of items) {
      let section = byName.get(item.section);
      if (!section) {
        section = { name: item.section, items: [] };
        byName.set(item.section, section);
        sections.push(section);
      }
      const completedName =
        item.completedBy?.displayName ?? item.completedBy?.email ?? null;
      section.items.push({
        id: item.id,
        label: item.label,
        completed: item.completedAt !== null,
        completedBy: completedName ? { name: completedName } : null,
        completedAt: item.completedAt ? item.completedAt.toISOString() : null,
      });
    }

    return {
      locationId: location.id,
      locationName: location.name,
      businessDate: businessDateToProjection(instance.businessDate),
      title,
      progress: {
        completed,
        total,
        isComplete: total > 0 && completed === total,
      },
      sections,
    };
  }

  // --- lookups ----------------------------------------------------

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

  private async requireOpeningTemplate(): Promise<{ id: string; name: string }> {
    const template = await this.prisma.checklistTemplate.findUnique({
      where: { key: OPENING_TEMPLATE_KEY },
      select: { id: true, name: true },
    });
    if (!template) {
      // Configuration error — the Opening Checklist template is seeded.
      throw new Error(
        'The Opening Checklist template is not configured. Run the database seed.',
      );
    }
    return template;
  }
}

function assertLocationId(locationId: unknown): string {
  if (typeof locationId !== 'string' || locationId.trim().length === 0) {
    throw new BadRequestException('locationId is required.');
  }
  return locationId.trim();
}

// A transaction-scoped row lock on the instance. All Complete/Undo
// mutations for one instance take it first, so their item flips and the
// completion recompute below serialize — two racing requests can never
// leave every item complete while ChecklistInstance.completedAt is still
// null (or vice versa).
async function lockInstance(
  tx: Prisma.TransactionClient,
  instanceId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ChecklistInstance" WHERE id = ${instanceId} FOR UPDATE`;
}

// Reconcile ChecklistInstance.completedAt from the authoritative current
// state of its items. Runs after every Complete and Undo:
//   - all items complete and the instance is not yet marked -> mark it.
//   - not all complete and the instance is marked -> clear it.
// Idempotent otherwise.
async function recomputeInstanceCompletion(
  tx: Prisma.TransactionClient,
  instanceId: string,
): Promise<void> {
  const items = await tx.checklistInstanceItem.findMany({
    where: { checklistInstanceId: instanceId },
    select: { completedAt: true },
  });
  const allComplete =
    items.length > 0 && items.every((item) => item.completedAt !== null);

  const instance = await tx.checklistInstance.findUniqueOrThrow({
    where: { id: instanceId },
    select: { completedAt: true },
  });

  if (allComplete && instance.completedAt === null) {
    await tx.checklistInstance.update({
      where: { id: instanceId },
      data: { completedAt: new Date() },
    });
  } else if (!allComplete && instance.completedAt !== null) {
    await tx.checklistInstance.update({
      where: { id: instanceId },
      data: { completedAt: null },
    });
  }
}
