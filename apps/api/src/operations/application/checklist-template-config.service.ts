import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  OpeningChecklistTemplateConfigResponse,
  OpeningChecklistTemplateItemConfig,
  OpeningChecklistTemplateSectionConfig,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { OPENING_TEMPLATE_KEY } from './opening-checklist.service';

const CONFIGURE_PERMISSION = 'operations.checklists.configure' as const;

const LABEL_MAX_LENGTH = 500;
const SECTION_MAX_LENGTH = 120;

type ItemRow = {
  id: string;
  section: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
};

// HQ configuration of the ONE corporate Opening Checklist template
// (Milestone 6B-2). The companion write surface to the 6B store-execution
// service: this side manages the TEMPLATE (item wording, active state,
// ordering, sections); that side runs a location's daily instance.
//
//   GET            — the full template, INCLUDING inactive items, grouped
//                    into sections in corporate display order.
//   PATCH item     — wording and/or active state.
//   POST item      — add an item to the end of a section (new or existing).
//   move item      — one step up / down within its own section.
//   rename section — move every item of one section to a new section name.
//   move section   — one step up / down in the checklist.
//
// Authorization: `operations.checklists.configure`, CORPORATE-only in the
// permission catalog. PermissionGuard rejects a LOCATION grant; every
// method re-asserts corporate scope as the service-layer defence. No
// `locationId` is accepted anywhere — one corporate standard.
//
// Historical safety: this service ONLY ever touches ChecklistTemplateItem.
// It never reads or writes ChecklistInstance / ChecklistInstanceItem, so a
// configuration change can never rewrite a checklist a location has already
// created. Changes take effect the next time a location creates its
// Opening Checklist (the 6B service snapshots ACTIVE template items by
// value at creation).
//
// Ordering model: `section` stays a plain string and `sortOrder` a single
// global sequence — no ChecklistSection table. The invariant "items of one
// section are contiguous when ordered by sortOrder" is re-established by
// `normalizeOrder` after every mutation, so section display order is
// simply the order the section runs appear in. Every mutation runs inside
// a transaction that first takes a row lock on the template, so concurrent
// HQ edits serialize (the same pattern the 6B service uses for an
// instance).
@Injectable()
export class ChecklistTemplateConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistTemplateConfigResponse> {
    authorization.assertCorporate(CONFIGURE_PERMISSION);
    const template = await this.requireTemplate();
    const items = await this.prisma.checklistTemplateItem.findMany({
      where: { templateId: template.id },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: SELECT_ITEM,
    });
    return buildConfigResponse(template.name, items);
  }

  async updateItem(
    itemId: string,
    input: { label?: unknown; isActive?: unknown },
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistTemplateConfigResponse> {
    authorization.assertCorporate(CONFIGURE_PERMISSION);

    const data: Prisma.ChecklistTemplateItemUpdateInput = {};

    if (input.label !== undefined) {
      if (typeof input.label !== 'string' || input.label.trim().length === 0) {
        throw new BadRequestException('Item wording cannot be empty.');
      }
      if (input.label.trim().length > LABEL_MAX_LENGTH) {
        throw new BadRequestException(
          `Item wording must be ${LABEL_MAX_LENGTH} characters or fewer.`,
        );
      }
      data.label = input.label.trim();
    }

    if (input.isActive !== undefined) {
      if (typeof input.isActive !== 'boolean') {
        throw new BadRequestException('Active state must be true or false.');
      }
      data.isActive = input.isActive;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Provide new wording or a new active state.',
      );
    }

    const template = await this.requireTemplate();
    await this.prisma.$transaction(async (tx) => {
      await lockTemplate(tx, template.id);
      const existing = await tx.checklistTemplateItem.findFirst({
        where: { id: assertId(itemId), templateId: template.id },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Checklist item not found.');
      }
      // Neither wording nor active state changes ordering or section, so no
      // renumber is needed here.
      await tx.checklistTemplateItem.update({
        where: { id: existing.id },
        data,
      });
    });

    return this.reload(template.id, template.name);
  }

  async addItem(
    input: { section?: unknown; label?: unknown },
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistTemplateConfigResponse> {
    authorization.assertCorporate(CONFIGURE_PERMISSION);

    if (
      typeof input.section !== 'string' ||
      input.section.trim().length === 0
    ) {
      throw new BadRequestException('A section name is required.');
    }
    if (typeof input.label !== 'string' || input.label.trim().length === 0) {
      throw new BadRequestException('Item wording is required.');
    }
    const section = input.section.trim();
    const label = input.label.trim();
    if (section.length > SECTION_MAX_LENGTH) {
      throw new BadRequestException(
        `A section name must be ${SECTION_MAX_LENGTH} characters or fewer.`,
      );
    }
    if (label.length > LABEL_MAX_LENGTH) {
      throw new BadRequestException(
        `Item wording must be ${LABEL_MAX_LENGTH} characters or fewer.`,
      );
    }

    const template = await this.requireTemplate();
    await this.prisma.$transaction(async (tx) => {
      await lockTemplate(tx, template.id);
      const items = await loadItems(tx, template.id);

      // Reuse an existing section when the name matches ignoring case and
      // surrounding / repeated whitespace, so "Equipment " never forks the
      // "Equipment" group.
      const existingSection = items.find(
        (item) => canonicalName(item.section) === canonicalName(section),
      );
      const resolvedSection = existingSection?.section ?? section;

      const nextSortOrder =
        items.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;

      await tx.checklistTemplateItem.create({
        data: {
          templateId: template.id,
          section: resolvedSection,
          label,
          sortOrder: nextSortOrder,
          isActive: true,
        },
      });

      // A brand-new section starts life last; an existing section absorbs
      // the item at the end of its run. normalizeOrder makes both true.
      await normalizeOrder(tx, template.id);
    });

    return this.reload(template.id, template.name);
  }

  async moveItem(
    itemId: string,
    direction: unknown,
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistTemplateConfigResponse> {
    authorization.assertCorporate(CONFIGURE_PERMISSION);
    assertDirection(direction);

    const template = await this.requireTemplate();
    await this.prisma.$transaction(async (tx) => {
      await lockTemplate(tx, template.id);
      const items = await loadItems(tx, template.id);
      const target = items.find((item) => item.id === assertId(itemId));
      if (!target) {
        throw new NotFoundException('Checklist item not found.');
      }

      const sectionItems = items.filter(
        (item) => item.section === target.section,
      );
      const index = sectionItems.findIndex((item) => item.id === target.id);
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= sectionItems.length) {
        throw new BadRequestException(
          `This item is already ${
            direction === 'up' ? 'first' : 'last'
          } in its section.`,
        );
      }

      const reorderedSection = swap(sectionItems, index, swapIndex);
      await applyOrder(
        tx,
        template.id,
        rebuildOrder(items, target.section, reorderedSection),
      );
    });

    return this.reload(template.id, template.name);
  }

  async renameSection(
    input: { from?: unknown; to?: unknown },
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistTemplateConfigResponse> {
    authorization.assertCorporate(CONFIGURE_PERMISSION);

    if (typeof input.from !== 'string' || input.from.trim().length === 0) {
      throw new BadRequestException('The section to rename is required.');
    }
    if (typeof input.to !== 'string' || input.to.trim().length === 0) {
      throw new BadRequestException('A new section name is required.');
    }
    const from = input.from.trim();
    const to = input.to.trim();
    if (to.length > SECTION_MAX_LENGTH) {
      throw new BadRequestException(
        `A section name must be ${SECTION_MAX_LENGTH} characters or fewer.`,
      );
    }

    const template = await this.requireTemplate();
    await this.prisma.$transaction(async (tx) => {
      await lockTemplate(tx, template.id);
      const items = await loadItems(tx, template.id);
      const sections = distinctSections(items);

      const current = sections.find(
        (name) => canonicalName(name) === canonicalName(from),
      );
      if (!current) {
        throw new NotFoundException('Section not found.');
      }

      // Renaming to a name another section already uses would merge them.
      // Only a pure re-casing / re-spacing of the SAME section is allowed
      // to "collide".
      const collides = sections.some(
        (name) => name !== current && canonicalName(name) === canonicalName(to),
      );
      if (collides) {
        throw new BadRequestException('Another section already has that name.');
      }

      if (current === to) {
        return;
      }

      await tx.checklistTemplateItem.updateMany({
        where: { templateId: template.id, section: current },
        data: { section: to },
      });
      // Renaming a whole contiguous run keeps the run contiguous; this just
      // guards the invariant.
      await normalizeOrder(tx, template.id);
    });

    return this.reload(template.id, template.name);
  }

  async moveSection(
    input: { section?: unknown; direction?: unknown },
    authorization: AuthorizationContext,
  ): Promise<OpeningChecklistTemplateConfigResponse> {
    authorization.assertCorporate(CONFIGURE_PERMISSION);

    if (
      typeof input.section !== 'string' ||
      input.section.trim().length === 0
    ) {
      throw new BadRequestException('The section to move is required.');
    }
    const sectionName = input.section.trim();
    const direction = input.direction;
    assertDirection(direction);

    const template = await this.requireTemplate();
    await this.prisma.$transaction(async (tx) => {
      await lockTemplate(tx, template.id);
      const items = await loadItems(tx, template.id);
      const sections = distinctSections(items);

      const current = sections.find(
        (name) => canonicalName(name) === canonicalName(sectionName),
      );
      if (!current) {
        throw new NotFoundException('Section not found.');
      }

      const index = sections.indexOf(current);
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= sections.length) {
        throw new BadRequestException(
          `This section is already ${direction === 'up' ? 'first' : 'last'}.`,
        );
      }

      const reordered = swap(sections, index, swapIndex);
      const orderedIds = reordered.flatMap((name) =>
        items.filter((item) => item.section === name).map((item) => item.id),
      );
      await applyOrder(tx, template.id, orderedIds);
    });

    return this.reload(template.id, template.name);
  }

  // --- internals ----------------------------------------------------

  private async reload(
    templateId: string,
    templateName: string,
  ): Promise<OpeningChecklistTemplateConfigResponse> {
    const items = await this.prisma.checklistTemplateItem.findMany({
      where: { templateId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: SELECT_ITEM,
    });
    return buildConfigResponse(templateName, items);
  }

  private async requireTemplate(): Promise<{ id: string; name: string }> {
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

const SELECT_ITEM = {
  id: true,
  section: true,
  label: true,
  sortOrder: true,
  isActive: true,
} satisfies Prisma.ChecklistTemplateItemSelect;

function assertId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new NotFoundException('Checklist item not found.');
  }
  return value.trim();
}

function assertDirection(value: unknown): asserts value is 'up' | 'down' {
  if (value !== 'up' && value !== 'down') {
    throw new BadRequestException('Direction must be "up" or "down".');
  }
}

// Case- and whitespace-insensitive section identity, for dedupe / matching.
function canonicalName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function loadItems(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<ItemRow[]> {
  return tx.checklistTemplateItem.findMany({
    where: { templateId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: SELECT_ITEM,
  });
}

// Section names in display order — the order each section's run first
// appears when items are read by sortOrder.
function distinctSections(items: ItemRow[]): string[] {
  const seen: string[] = [];
  for (const item of items) {
    if (!seen.includes(item.section)) {
      seen.push(item.section);
    }
  }
  return seen;
}

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  const copy = [...list];
  [copy[a], copy[b]] = [copy[b], copy[a]];
  return copy;
}

// Splice a reordered single section back into the full item order,
// preserving every other section's position and internal order.
function rebuildOrder(
  allItems: ItemRow[],
  section: string,
  reorderedSection: ItemRow[],
): string[] {
  const sections = distinctSections(allItems);
  return sections.flatMap((name) =>
    name === section
      ? reorderedSection.map((item) => item.id)
      : allItems.filter((item) => item.section === name).map((item) => item.id),
  );
}

// Recompute the canonical order (sections in first-appearance order, each
// section's items in their current relative order) and write it. Idempotent
// and self-healing: if storage ever held a non-contiguous section, this
// makes it contiguous.
async function normalizeOrder(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<void> {
  const items = await loadItems(tx, templateId);
  const sections = distinctSections(items);
  const orderedIds = sections.flatMap((name) =>
    items.filter((item) => item.section === name).map((item) => item.id),
  );
  await applyOrder(tx, templateId, orderedIds, items);
}

// Impose an explicit full ordering: item at position i gets sortOrder i+1.
// Only rows whose number actually changes are written.
async function applyOrder(
  tx: Prisma.TransactionClient,
  templateId: string,
  orderedIds: string[],
  known?: ItemRow[],
): Promise<void> {
  const current = known ?? (await loadItems(tx, templateId));
  const bySortOrder = new Map(current.map((item) => [item.id, item.sortOrder]));
  for (let i = 0; i < orderedIds.length; i += 1) {
    const id = orderedIds[i];
    if (bySortOrder.get(id) !== i + 1) {
      await tx.checklistTemplateItem.update({
        where: { id },
        data: { sortOrder: i + 1 },
      });
    }
  }
}

// Transaction-scoped row lock on the template. Every configuration mutation
// takes it first, so their reads + renumbering serialize — two racing
// moves can never interleave into a corrupt order.
async function lockTemplate(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ChecklistTemplate" WHERE id = ${templateId} FOR UPDATE`;
}

function buildConfigResponse(
  title: string,
  items: ItemRow[],
): OpeningChecklistTemplateConfigResponse {
  const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder);

  const sections: OpeningChecklistTemplateSectionConfig[] = [];
  const byName = new Map<string, OpeningChecklistTemplateItemConfig[]>();

  for (const item of ordered) {
    let bucket = byName.get(item.section);
    if (!bucket) {
      bucket = [];
      byName.set(item.section, bucket);
      sections.push({
        name: item.section,
        canMoveUp: false,
        canMoveDown: false,
        items: bucket,
      });
    }
    bucket.push({
      id: item.id,
      label: item.label,
      isActive: item.isActive,
      canMoveUp: false,
      canMoveDown: false,
    });
  }

  sections.forEach((section, sectionIndex) => {
    section.canMoveUp = sectionIndex > 0;
    section.canMoveDown = sectionIndex < sections.length - 1;
    section.items.forEach((item, itemIndex) => {
      item.canMoveUp = itemIndex > 0;
      item.canMoveDown = itemIndex < section.items.length - 1;
    });
  });

  return { title, sections };
}
