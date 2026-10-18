import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MODIFIER_GROUP_MAX_OPTIONS,
  PRODUCT_MAX_MODIFIER_GROUPS,
  type AdminModifierGroupDetail,
  type AdminModifierGroupSummary,
  type AdminProductModifiersResponse,
} from '@mocha-house/contracts';
import type { Prisma, TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InternalAuditService,
  type ModifierAuditAction,
} from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  assertSelectionRange,
  type CreateModifierGroupInput,
  type CreateModifierOptionInput,
  type UpdateModifierGroupInput,
  type UpdateModifierOptionInput,
} from './modifier-input';

// Product Modifier Management — a business's reusable modifier groups, their
// options, and which of its products use them.
//
// Tenancy: every read and write is for the server-resolved business only
// (`tenant`); a group, option or product of another business reads exactly
// like a missing one (404). The composite (tenantId, id) foreign keys are
// the database backstop for every link.
//
// Orderability: no change may leave a product unable to be configured. An
// ACTIVE group attached to any product must keep at least max(minimum, 1)
// active options (an inactive group is simply not offered, so it never
// blocks a product). Changes that would break that are refused (409) with
// the affected products named.
//
// Concurrency: each change runs in one transaction that first locks the
// group row (and, for a product's attachments, the product row, always
// before the group), so two edits can never each pass the orderability
// check against the other's stale state, and the audit "before" is exact.
// Every change and its audit event commit together.
type Tx = Prisma.TransactionClient;

const GROUP_DETAIL_SELECT = {
  id: true,
  name: true,
  isRequired: true,
  minSelections: true,
  maxSelections: true,
  isActive: true,
} as const;

@Injectable()
export class ModifierManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  // --- Reads (catalog.view) --------------------------------------------

  async listGroups(
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminModifierGroupSummary[]> {
    authorization.assertCorporate('catalog.view');
    const tenantId = tenant.tenantId;
    const groups = await this.prisma.modifierGroup.findMany({
      where: { tenantId },
      select: {
        ...GROUP_DETAIL_SELECT,
        options: { where: { tenantId }, select: { isActive: true } },
        _count: { select: { products: true } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      isRequired: group.isRequired,
      minSelections: group.minSelections,
      maxSelections: group.maxSelections,
      isActive: group.isActive,
      optionCount: group.options.length,
      activeOptionCount: group.options.filter((o) => o.isActive).length,
      productCount: group._count.products,
    }));
  }

  async getGroup(
    groupId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminModifierGroupDetail> {
    authorization.assertCorporate('catalog.view');
    return this.groupDetail(this.prisma, groupId, tenant.tenantId);
  }

  async getProductModifiers(
    productId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminProductModifiersResponse> {
    authorization.assertCorporate('catalog.view');
    await this.requireProduct(this.prisma, productId, tenant.tenantId);
    return this.productModifiers(this.prisma, productId, tenant.tenantId);
  }

  // --- Groups (catalog.products.edit) ----------------------------------

  async createGroup(
    input: CreateModifierGroupInput,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminModifierGroupDetail> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.modifierGroup.aggregate({
        where: { tenantId },
        _max: { displayOrder: true },
      });
      const created = await tx.modifierGroup.create({
        data: {
          tenantId,
          name: input.name,
          minSelections: input.minSelections,
          maxSelections: input.maxSelections,
          isRequired: input.minSelections >= 1,
          isActive: true,
          displayOrder: (last._max.displayOrder ?? 0) + 1,
        },
        select: GROUP_DETAIL_SELECT,
      });
      await this.record(tx, actorInternalUserId, {
        action: 'catalog.modifier_group_created',
        targetType: 'modifier_group',
        targetId: created.id,
        beforeData: { group: null },
        afterData: groupSnapshot(created),
      });
      return this.groupDetail(tx, created.id, tenantId);
    });
  }

  async updateGroup(
    groupId: string,
    input: UpdateModifierGroupInput,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminModifierGroupDetail> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      await this.lockGroup(tx, groupId, tenantId);
      const current = await tx.modifierGroup.findFirstOrThrow({
        where: { id: groupId, tenantId },
        select: GROUP_DETAIL_SELECT,
      });
      const next = {
        name: input.name ?? current.name,
        minSelections: input.minSelections ?? current.minSelections,
        maxSelections:
          input.maxSelections !== undefined
            ? input.maxSelections
            : current.maxSelections,
        isActive: input.isActive ?? current.isActive,
      };
      assertSelectionRange(next.minSelections, next.maxSelections);
      const isRequired = next.minSelections >= 1;

      await this.assertGroupStaysOrderable(tx, groupId, tenantId, {
        isActive: next.isActive,
        minSelections: next.minSelections,
        activeOptionCount: await this.activeOptionCount(tx, groupId, tenantId),
      });

      const before = groupSnapshot(current);
      const after = groupSnapshot({ ...current, ...next, isRequired });
      const changed = changedFields(before, after);
      if (changed.length > 0) {
        await tx.modifierGroup.updateMany({
          where: { id: groupId, tenantId },
          data: { ...next, isRequired },
        });
        await this.record(tx, actorInternalUserId, {
          action: 'catalog.modifier_group_updated',
          targetType: 'modifier_group',
          targetId: groupId,
          beforeData: pick(before, changed),
          afterData: pick(after, changed),
        });
      }
      return this.groupDetail(tx, groupId, tenantId);
    });
  }

  // --- Options (catalog.products.edit) ---------------------------------

  async createOption(
    groupId: string,
    input: CreateModifierOptionInput,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminModifierGroupDetail> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      await this.lockGroup(tx, groupId, tenantId);
      const options = await tx.modifierOption.findMany({
        where: { tenantId, modifierGroupId: groupId },
        select: { name: true, displayOrder: true },
      });
      if (options.length >= MODIFIER_GROUP_MAX_OPTIONS) {
        throw new BadRequestException(
          `A modifier group can have at most ${MODIFIER_GROUP_MAX_OPTIONS} options.`,
        );
      }
      assertUniqueOptionName(options, input.name);
      const created = await tx.modifierOption.create({
        data: {
          tenantId,
          modifierGroupId: groupId,
          name: input.name,
          priceAdjustment: input.priceAdjustment,
          isActive: true,
          displayOrder:
            options.reduce((max, o) => Math.max(max, o.displayOrder), 0) + 1,
        },
        select: {
          id: true,
          name: true,
          priceAdjustment: true,
          displayOrder: true,
          isActive: true,
        },
      });
      await this.record(tx, actorInternalUserId, {
        action: 'catalog.modifier_option_created',
        targetType: 'modifier_option',
        targetId: created.id,
        beforeData: { option: null },
        afterData: { modifierGroupId: groupId, ...optionSnapshot(created) },
      });
      return this.groupDetail(tx, groupId, tenantId);
    });
  }

  async updateOption(
    groupId: string,
    optionId: string,
    input: UpdateModifierOptionInput,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminModifierGroupDetail> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      await this.lockGroup(tx, groupId, tenantId);
      requireIdShape(optionId, 'Option not found.');
      const current = await tx.modifierOption.findFirst({
        where: { id: optionId, tenantId, modifierGroupId: groupId },
        select: {
          id: true,
          name: true,
          priceAdjustment: true,
          displayOrder: true,
          isActive: true,
        },
      });
      if (!current) {
        throw new NotFoundException('Option not found.');
      }
      const next = {
        name: input.name ?? current.name,
        priceAdjustment: input.priceAdjustment ?? current.priceAdjustment,
        isActive: input.isActive ?? current.isActive,
      };
      if (next.name !== current.name) {
        const siblings = await tx.modifierOption.findMany({
          where: { tenantId, modifierGroupId: groupId, NOT: { id: optionId } },
          select: { name: true },
        });
        assertUniqueOptionName(siblings, next.name);
      }
      if (current.isActive && !next.isActive) {
        const group = await tx.modifierGroup.findFirstOrThrow({
          where: { id: groupId, tenantId },
          select: { isActive: true, minSelections: true },
        });
        await this.assertGroupStaysOrderable(tx, groupId, tenantId, {
          isActive: group.isActive,
          minSelections: group.minSelections,
          activeOptionCount:
            (await this.activeOptionCount(tx, groupId, tenantId)) - 1,
        });
      }

      const before = optionSnapshot(current);
      const after = optionSnapshot({ ...current, ...next });
      const changed = changedFields(before, after);
      if (changed.length > 0) {
        await tx.modifierOption.updateMany({
          where: { id: optionId, tenantId, modifierGroupId: groupId },
          data: next,
        });
        await this.record(tx, actorInternalUserId, {
          action: 'catalog.modifier_option_updated',
          targetType: 'modifier_option',
          targetId: optionId,
          beforeData: { modifierGroupId: groupId, ...pick(before, changed) },
          afterData: { modifierGroupId: groupId, ...pick(after, changed) },
        });
      }
      return this.groupDetail(tx, groupId, tenantId);
    });
  }

  async reorderOptions(
    groupId: string,
    optionIds: string[],
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminModifierGroupDetail> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      await this.lockGroup(tx, groupId, tenantId);
      const current = await tx.modifierOption.findMany({
        where: { tenantId, modifierGroupId: groupId },
        select: { id: true },
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      });
      const before = current.map((o) => o.id);
      assertSameSet(before, optionIds, 'option');
      if (!sameOrder(before, optionIds)) {
        for (const [index, id] of optionIds.entries()) {
          await tx.modifierOption.updateMany({
            where: { id, tenantId, modifierGroupId: groupId },
            data: { displayOrder: index + 1 },
          });
        }
        await this.record(tx, actorInternalUserId, {
          action: 'catalog.modifier_options_reordered',
          targetType: 'modifier_group',
          targetId: groupId,
          beforeData: { optionIds: before },
          afterData: { optionIds },
        });
      }
      return this.groupDetail(tx, groupId, tenantId);
    });
  }

  // --- A product's groups (catalog.products.edit) ----------------------

  async attachGroup(
    productId: string,
    groupId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminProductModifiersResponse> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      await this.lockProduct(tx, productId, tenantId);
      await this.lockGroup(tx, groupId, tenantId);
      const before = await this.attachedGroupIds(tx, productId, tenantId);
      if (before.includes(groupId)) {
        // Idempotent: already attached, nothing changes or is recorded.
        return this.productModifiers(tx, productId, tenantId);
      }
      if (before.length >= PRODUCT_MAX_MODIFIER_GROUPS) {
        throw new BadRequestException(
          `A product can have at most ${PRODUCT_MAX_MODIFIER_GROUPS} modifier groups.`,
        );
      }
      const group = await tx.modifierGroup.findFirstOrThrow({
        where: { id: groupId, tenantId },
        select: { name: true, isActive: true, minSelections: true },
      });
      if (!group.isActive) {
        throw new ConflictException(
          `"${group.name}" is inactive. Reactivate it before adding it to a product.`,
        );
      }
      const needed = Math.max(group.minSelections, 1);
      const active = await this.activeOptionCount(tx, groupId, tenantId);
      if (active < needed) {
        throw new ConflictException(
          `"${group.name}" needs at least ${needed} active option${needed === 1 ? '' : 's'} before it can be added to a product.`,
        );
      }
      const last = await tx.productModifierGroup.aggregate({
        where: { tenantId, productId },
        _max: { displayOrder: true },
      });
      await tx.productModifierGroup.create({
        data: {
          tenantId,
          productId,
          modifierGroupId: groupId,
          displayOrder: (last._max.displayOrder ?? 0) + 1,
        },
      });
      await this.record(tx, actorInternalUserId, {
        action: 'catalog.product_modifier_group_attached',
        targetType: 'product',
        targetId: productId,
        beforeData: { modifierGroupIds: before },
        afterData: {
          modifierGroupId: groupId,
          modifierGroupIds: [...before, groupId],
        },
      });
      return this.productModifiers(tx, productId, tenantId);
    });
  }

  async detachGroup(
    productId: string,
    groupId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminProductModifiersResponse> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      await this.lockProduct(tx, productId, tenantId);
      const before = await this.attachedGroupIds(tx, productId, tenantId);
      if (!before.includes(groupId)) {
        throw new NotFoundException(
          'That modifier group is not on this product.',
        );
      }
      await tx.productModifierGroup.deleteMany({
        where: { tenantId, productId, modifierGroupId: groupId },
      });
      await this.record(tx, actorInternalUserId, {
        action: 'catalog.product_modifier_group_detached',
        targetType: 'product',
        targetId: productId,
        beforeData: { modifierGroupIds: before },
        afterData: {
          modifierGroupId: groupId,
          modifierGroupIds: before.filter((id) => id !== groupId),
        },
      });
      return this.productModifiers(tx, productId, tenantId);
    });
  }

  async reorderProductGroups(
    productId: string,
    groupIds: string[],
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminProductModifiersResponse> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;
    return this.prisma.$transaction(async (tx) => {
      await this.lockProduct(tx, productId, tenantId);
      const before = await this.attachedGroupIds(tx, productId, tenantId);
      assertSameSet(before, groupIds, 'modifier group');
      if (!sameOrder(before, groupIds)) {
        for (const [index, modifierGroupId] of groupIds.entries()) {
          await tx.productModifierGroup.updateMany({
            where: { tenantId, productId, modifierGroupId },
            data: { displayOrder: index + 1 },
          });
        }
        await this.record(tx, actorInternalUserId, {
          action: 'catalog.product_modifier_groups_reordered',
          targetType: 'product',
          targetId: productId,
          beforeData: { modifierGroupIds: before },
          afterData: { modifierGroupIds: groupIds },
        });
      }
      return this.productModifiers(tx, productId, tenantId);
    });
  }

  // --- Helpers ------------------------------------------------------------

  private async record(
    tx: Tx,
    actorInternalUserId: string,
    event: {
      action: ModifierAuditAction;
      targetType: 'modifier_group' | 'modifier_option' | 'product';
      targetId: string;
      beforeData: Prisma.InputJsonObject;
      afterData: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    await this.audit.recordModifierChange(tx, {
      actorInternalUserId,
      ...event,
    });
  }

  // The business's own group, locked for the rest of the transaction.
  private async lockGroup(
    tx: Tx,
    groupId: string,
    tenantId: string,
  ): Promise<void> {
    requireIdShape(groupId, 'Modifier group not found.');
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ModifierGroup"
      WHERE id = ${groupId} AND "tenantId" = ${tenantId}
      FOR UPDATE`;
    if (rows.length === 0) {
      throw new NotFoundException('Modifier group not found.');
    }
  }

  private async lockProduct(
    tx: Tx,
    productId: string,
    tenantId: string,
  ): Promise<void> {
    requireIdShape(productId, 'Product not found.');
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Product"
      WHERE id = ${productId} AND "tenantId" = ${tenantId}
      FOR UPDATE`;
    if (rows.length === 0) {
      throw new NotFoundException('Product not found.');
    }
  }

  private async requireProduct(
    db: Tx | PrismaService,
    productId: string,
    tenantId: string,
  ): Promise<void> {
    requireIdShape(productId, 'Product not found.');
    const product = await db.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException('Product not found.');
    }
  }

  private async activeOptionCount(
    tx: Tx,
    groupId: string,
    tenantId: string,
  ): Promise<number> {
    return tx.modifierOption.count({
      where: { tenantId, modifierGroupId: groupId, isActive: true },
    });
  }

  // Refuses a group state that some attached product could not satisfy.
  private async assertGroupStaysOrderable(
    tx: Tx,
    groupId: string,
    tenantId: string,
    state: {
      isActive: boolean;
      minSelections: number;
      activeOptionCount: number;
    },
  ): Promise<void> {
    if (!state.isActive) return;
    const needed = Math.max(state.minSelections, 1);
    if (state.activeOptionCount >= needed) return;
    const attached = await tx.productModifierGroup.findMany({
      where: { tenantId, modifierGroupId: groupId },
      select: { product: { select: { name: true } } },
      orderBy: { product: { name: 'asc' } },
    });
    if (attached.length === 0) return;
    const names = attached.map((a) => a.product.name);
    const listed =
      names.length > 3
        ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
        : names.join(', ');
    throw new ConflictException(
      `This change would leave the group with fewer than ${needed} active option${needed === 1 ? '' : 's'}, so customers couldn't complete ${names.length === 1 ? 'this product' : 'these products'}: ${listed}. Add or reactivate options, lower the minimum, or remove the group from ${names.length === 1 ? 'the product' : 'those products'} first.`,
    );
  }

  private async attachedGroupIds(
    tx: Tx,
    productId: string,
    tenantId: string,
  ): Promise<string[]> {
    const links = await tx.productModifierGroup.findMany({
      where: { tenantId, productId },
      select: { modifierGroupId: true },
      orderBy: [{ displayOrder: 'asc' }, { modifierGroupId: 'asc' }],
    });
    return links.map((link) => link.modifierGroupId);
  }

  private async groupDetail(
    db: Tx | PrismaService,
    groupId: string,
    tenantId: string,
  ): Promise<AdminModifierGroupDetail> {
    requireIdShape(groupId, 'Modifier group not found.');
    const group = await db.modifierGroup.findFirst({
      where: { id: groupId, tenantId },
      select: {
        ...GROUP_DETAIL_SELECT,
        options: {
          where: { tenantId },
          select: {
            id: true,
            name: true,
            priceAdjustment: true,
            displayOrder: true,
            isActive: true,
          },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        },
        products: {
          where: { tenantId },
          select: {
            product: { select: { id: true, name: true, isActive: true } },
          },
          orderBy: { product: { name: 'asc' } },
        },
      },
    });
    if (!group) {
      throw new NotFoundException('Modifier group not found.');
    }
    return {
      id: group.id,
      name: group.name,
      isRequired: group.isRequired,
      minSelections: group.minSelections,
      maxSelections: group.maxSelections,
      isActive: group.isActive,
      options: group.options,
      products: group.products.map((link) => link.product),
    };
  }

  private async productModifiers(
    db: Tx | PrismaService,
    productId: string,
    tenantId: string,
  ): Promise<AdminProductModifiersResponse> {
    const links = await db.productModifierGroup.findMany({
      where: { tenantId, productId },
      select: {
        modifierGroup: {
          select: {
            ...GROUP_DETAIL_SELECT,
            options: { where: { tenantId }, select: { isActive: true } },
            _count: { select: { products: true } },
          },
        },
      },
      orderBy: [{ displayOrder: 'asc' }, { modifierGroupId: 'asc' }],
    });
    return {
      productId,
      groups: links.map(({ modifierGroup: group }) => ({
        id: group.id,
        name: group.name,
        isRequired: group.isRequired,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        isActive: group.isActive,
        activeOptionCount: group.options.filter((o) => o.isActive).length,
        productCount: group._count.products,
      })),
    };
  }
}

// Path ids are never trusted: one too long to be ours, or holding a NUL
// (which PostgreSQL text cannot store), is simply not found — never a 500.
function requireIdShape(id: string, message: string): void {
  if (id.length === 0 || id.length > 64 || id.includes('\u0000')) {
    throw new NotFoundException(message);
  }
}

type Snapshot = Record<string, string | number | boolean | null>;

function groupSnapshot(group: {
  name: string;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number | null;
  isActive: boolean;
}): Snapshot {
  return {
    name: group.name,
    isRequired: group.isRequired,
    minSelections: group.minSelections,
    maxSelections: group.maxSelections,
    isActive: group.isActive,
  };
}

function optionSnapshot(option: {
  name: string;
  priceAdjustment: number;
  displayOrder: number;
  isActive: boolean;
}): Snapshot {
  return {
    name: option.name,
    priceAdjustment: option.priceAdjustment,
    displayOrder: option.displayOrder,
    isActive: option.isActive,
  };
}

function changedFields(before: Snapshot, after: Snapshot): string[] {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

function pick(snapshot: Snapshot, keys: string[]): Snapshot {
  return Object.fromEntries(keys.map((key) => [key, snapshot[key]]));
}

// Two options of one group may not share a name (ignoring case and
// surrounding spaces) — customers could not tell them apart.
function assertUniqueOptionName(
  options: { name: string }[],
  name: string,
): void {
  const wanted = name.trim().toLocaleLowerCase();
  if (options.some((o) => o.name.trim().toLocaleLowerCase() === wanted)) {
    throw new ConflictException(
      `This group already has an option called "${name}".`,
    );
  }
}

function assertSameSet(current: string[], wanted: string[], label: string) {
  const known = new Set(current);
  if (wanted.length !== current.length || wanted.some((id) => !known.has(id))) {
    throw new BadRequestException(
      `List every ${label} exactly once to change the order.`,
    );
  }
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
