import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_TAX_CLASS_NAME,
  PLATFORM_ADMINISTRATOR_ROLE,
  TAX_CATEGORIES_UNREVIEWED,
  TAX_CLASS_NAME_MAX,
  TAX_CLASS_NAME_TAKEN,
  TAX_COMPONENT_NAME_MAX,
  TAX_COMPONENTS_MAX,
  TAX_DRAFT_CHANGED,
  TAX_JURISDICTIONS,
  TAX_SETTINGS_OWNER_ONLY,
  formatTaxRatePpm,
  parseTaxRatePercent,
  type AdminLocationTaxResponse,
  type AdminTaxCategory,
  type AdminTaxClass,
  type AdminTaxProduct,
  type AdminTaxLocationSummary,
  type AdminTaxSettingsResponse,
  type AdminTaxVersion,
  type TaxJurisdiction,
  type TaxVersionStatus,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';

// V1 Sales Tax PR 1 — the business's sales tax settings: its tax classes,
// how each category (and, optionally, product) is classified, and each
// location's versioned tax rules. Configuration only: nothing here changes an
// order total, a payment, a refund or a report.
//
//   * AUTHORIZED ADMINISTRATOR ONLY: the caller holds tax.manage at corporate
//     scope (guard + controller) AND the business's built-in administrator
//     role at corporate scope (checked here, from the database). Store
//     Managers never can.
//   * TENANT ISOLATION: every read and write is scoped to the request's
//     business; every id from the request is looked up inside that business
//     (another business's id is simply "not found"), and the database's
//     composite foreign keys refuse a cross-business link regardless.
//   * VERSIONS: a confirmed version is never edited (database guard). Saving
//     changes edits the location's single DRAFT; confirming it supersedes the
//     previous confirmed version, which is kept.
//   * EXACT RATES: integer parts per million, parsed from the typed
//     percentage digit by digit (never a floating-point number).

const CLASS_LIMIT = 50;
const DEFAULT_SYSTEM_KEY = 'PREPARED_FOOD';

type Db = Prisma.TransactionClient | PrismaService;

const VERSION_INCLUDE = {
  components: {
    orderBy: { displayOrder: 'asc' },
    include: { classes: { select: { taxClassId: true } } },
  },
  confirmedBy: { select: { displayName: true, email: true } },
} satisfies Prisma.LocationTaxVersionInclude;

type VersionRow = Prisma.LocationTaxVersionGetPayload<{
  include: typeof VERSION_INCLUDE;
}>;

interface ParsedComponent {
  name: string;
  jurisdiction: TaxJurisdiction;
  ratePpm: number;
  taxClassIds: string[];
}

@Injectable()
export class TaxSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  // The business's built-in administrator (owner), at corporate scope, and
  // still active.
  async assertAuthorizedAdministrator(
    tenantId: string,
    internalUserId: string,
  ): Promise<void> {
    const owner = await this.prisma.internalUserRoleAssignment.findFirst({
      where: {
        tenantId,
        internalUserId,
        scopeType: 'CORPORATE',
        scopeId: null,
        role: {
          tenantId,
          key: PLATFORM_ADMINISTRATOR_ROLE.key,
          isSystem: true,
        },
        internalUser: { tenantId, status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!owner) {
      throw new ForbiddenException({
        code: TAX_SETTINGS_OWNER_ONLY,
        message:
          "Only the business's authorized administrator can manage sales tax settings.",
      });
    }
  }

  // --- settings overview ------------------------------------------------------

  async settings(tenantId: string): Promise<AdminTaxSettingsResponse> {
    const defaultClass = await this.ensureDefaultClass(this.prisma, tenantId);
    const [classes, categories, products, locations] = await Promise.all([
      this.classes(this.prisma, tenantId),
      this.prisma.category.findMany({
        where: { tenantId },
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          isActive: true,
          taxClassId: true,
          taxClassReviewedAt: true,
        },
      }),
      this.prisma.product.findMany({
        where: { tenantId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          isActive: true,
          categoryId: true,
          taxClassId: true,
        },
      }),
      this.prisma.location.findMany({
        where: { tenantId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true },
      }),
    ]);

    const versions = await this.prisma.locationTaxVersion.findMany({
      where: { tenantId, status: { in: ['DRAFT', 'CONFIRMED'] } },
      include: VERSION_INCLUDE,
    });
    const confirmedOf = new Map<string, VersionRow>();
    const draftOf = new Set<string>();
    for (const version of versions) {
      if (version.status === 'CONFIRMED') {
        confirmedOf.set(version.locationId, version);
      } else {
        draftOf.add(version.locationId);
      }
    }

    const summaries: AdminTaxLocationSummary[] = locations.map((location) => {
      const confirmed = confirmedOf.get(location.id) ?? null;
      const hasDraft = draftOf.has(location.id);
      return {
        id: location.id,
        name: location.name,
        state: confirmed ? 'CONFIRMED' : hasDraft ? 'DRAFT' : 'NOT_SET',
        hasDraft,
        confirmedVersion: confirmed?.version ?? null,
        confirmedAt: confirmed?.confirmedAt?.toISOString() ?? null,
        confirmedDefaultRatePpm: confirmed
          ? confirmed.components
              .filter((component) =>
                component.classes.some(
                  (link) => link.taxClassId === defaultClass.id,
                ),
              )
              .reduce((sum, component) => sum + component.ratePpm, 0)
          : null,
      };
    });

    return {
      classes,
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        isActive: category.isActive,
        taxClassId: category.taxClassId ?? defaultClass.id,
        reviewed: category.taxClassReviewedAt !== null,
      })),
      products: products.map((product) => ({
        id: product.id,
        name: product.name,
        isActive: product.isActive,
        categoryId: product.categoryId,
        overrideTaxClassId: product.taxClassId,
      })),
      locations: summaries,
      unreviewedActiveCategories: categories.filter(
        (category) => category.isActive && category.taxClassReviewedAt === null,
      ).length,
      pricesIncludeTax: false,
      taxCollectionEnabled: false,
    };
  }

  // --- tax classes ------------------------------------------------------------

  async createClass(
    tenantId: string,
    actorInternalUserId: string,
    rawName: unknown,
  ): Promise<AdminTaxClass> {
    const name = className(rawName);
    await this.ensureDefaultClass(this.prisma, tenantId);
    const count = await this.prisma.taxClass.count({ where: { tenantId } });
    if (count >= CLASS_LIMIT) {
      throw new BadRequestException(
        `A business can have at most ${CLASS_LIMIT} tax classes.`,
      );
    }
    const created = await this.uniqueName(() =>
      this.prisma.$transaction(async (tx) => {
        const row = await tx.taxClass.create({
          data: { tenantId, name },
          select: { id: true, name: true, systemKey: true },
        });
        await this.audit.recordTaxSettingsAction(tx, {
          actorInternalUserId,
          action: 'tax.class_created',
          targetType: 'tax_class',
          targetId: row.id,
          afterData: { name: row.name },
        });
        return row;
      }),
    );
    return toClass(created);
  }

  async renameClass(
    tenantId: string,
    actorInternalUserId: string,
    taxClassId: string,
    rawName: unknown,
  ): Promise<AdminTaxClass> {
    const name = className(rawName);
    const updated = await this.uniqueName(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.taxClass.findFirst({
          where: { tenantId, id: taxClassId },
          select: { id: true, name: true },
        });
        if (!existing) throw new NotFoundException('Tax class not found.');
        const row = await tx.taxClass.update({
          where: { tenantId_id: { tenantId, id: taxClassId } },
          data: { name },
          select: { id: true, name: true, systemKey: true },
        });
        if (existing.name !== row.name) {
          await this.audit.recordTaxSettingsAction(tx, {
            actorInternalUserId,
            action: 'tax.class_renamed',
            targetType: 'tax_class',
            targetId: row.id,
            beforeData: { name: existing.name },
            afterData: { name: row.name },
          });
        }
        return row;
      }),
    );
    return toClass(updated);
  }

  // --- classification ---------------------------------------------------------

  // An explicit review: the administrator chose this category's class (even
  // when it is the default).
  async classifyCategory(
    tenantId: string,
    actorInternalUserId: string,
    categoryId: string,
    rawTaxClassId: unknown,
  ): Promise<AdminTaxCategory> {
    const taxClassId = requiredId(rawTaxClassId, 'Choose a tax class.');
    await this.ensureDefaultClass(this.prisma, tenantId);
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findFirst({
        where: { tenantId, id: categoryId },
        select: {
          id: true,
          name: true,
          isActive: true,
          taxClassId: true,
          taxClassReviewedAt: true,
        },
      });
      if (!category) throw new NotFoundException('Category not found.');
      await this.assertClassExists(tx, tenantId, taxClassId);
      await tx.category.update({
        where: { tenantId_id: { tenantId, id: categoryId } },
        data: { taxClassId, taxClassReviewedAt: new Date() },
      });
      await this.audit.recordTaxSettingsAction(tx, {
        actorInternalUserId,
        action: 'tax.category_classified',
        targetType: 'category',
        targetId: categoryId,
        beforeData: {
          taxClassId: category.taxClassId,
          reviewed: category.taxClassReviewedAt !== null,
        },
        afterData: { taxClassId, reviewed: true },
      });
      return {
        id: category.id,
        name: category.name,
        isActive: category.isActive,
        taxClassId,
        reviewed: true,
      };
    });
  }

  // A product's own class, overriding its category's; null clears it.
  async setProductClass(
    tenantId: string,
    actorInternalUserId: string,
    productId: string,
    rawTaxClassId: unknown,
  ): Promise<AdminTaxProduct> {
    const taxClassId =
      rawTaxClassId === null
        ? null
        : requiredId(rawTaxClassId, 'Choose a tax class or clear it.');
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { tenantId, id: productId },
        select: {
          id: true,
          name: true,
          isActive: true,
          categoryId: true,
          taxClassId: true,
        },
      });
      if (!product) throw new NotFoundException('Product not found.');
      if (taxClassId !== null) {
        await this.assertClassExists(tx, tenantId, taxClassId);
      }
      const result: AdminTaxProduct = {
        id: product.id,
        name: product.name,
        isActive: product.isActive,
        categoryId: product.categoryId,
        overrideTaxClassId: taxClassId,
      };
      if (product.taxClassId === taxClassId) return result;
      await tx.product.update({
        where: { tenantId_id: { tenantId, id: productId } },
        data: { taxClassId },
      });
      await this.audit.recordTaxSettingsAction(tx, {
        actorInternalUserId,
        action:
          taxClassId === null
            ? 'tax.product_class_cleared'
            : 'tax.product_class_set',
        targetType: 'product',
        targetId: productId,
        beforeData: { taxClassId: product.taxClassId },
        afterData: { taxClassId },
      });
      return result;
    });
  }

  // --- location tax settings --------------------------------------------------

  async location(
    tenantId: string,
    locationId: string,
  ): Promise<AdminLocationTaxResponse> {
    await this.ensureDefaultClass(this.prisma, tenantId);
    return this.locationResponse(this.prisma, tenantId, locationId);
  }

  // Replaces the location's draft taxes, creating the draft (the next
  // version number) when there is none. Confirmed versions are untouched.
  async saveDraft(
    tenantId: string,
    actorInternalUserId: string,
    locationId: string,
    rawComponents: unknown,
  ): Promise<AdminLocationTaxResponse> {
    const components = parseComponents(rawComponents);
    await this.ensureDefaultClass(this.prisma, tenantId);
    return this.draftConflict(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockLocation(tx, tenantId, locationId);
        const classIds = [...new Set(components.flatMap((c) => c.taxClassIds))];
        const known = await tx.taxClass.count({
          where: { tenantId, id: { in: classIds } },
        });
        if (known !== classIds.length) {
          throw new BadRequestException('Choose tax classes from this list.');
        }

        let draft = await tx.locationTaxVersion.findFirst({
          where: { tenantId, locationId, status: 'DRAFT' },
          select: { id: true },
        });
        if (draft) {
          await tx.locationTaxComponentClass.deleteMany({
            where: { tenantId, component: { tenantId, versionId: draft.id } },
          });
          await tx.locationTaxComponent.deleteMany({
            where: { tenantId, versionId: draft.id },
          });
          await tx.locationTaxVersion.update({
            where: { tenantId_id: { tenantId, id: draft.id } },
            data: { updatedAt: new Date() },
          });
        } else {
          const latest = await tx.locationTaxVersion.aggregate({
            where: { tenantId, locationId },
            _max: { version: true },
          });
          draft = await tx.locationTaxVersion.create({
            data: {
              tenantId,
              locationId,
              version: (latest._max.version ?? 0) + 1,
              status: 'DRAFT',
            },
            select: { id: true },
          });
        }

        for (const [index, component] of components.entries()) {
          const row = await tx.locationTaxComponent.create({
            data: {
              tenantId,
              versionId: draft.id,
              name: component.name,
              jurisdiction: component.jurisdiction,
              ratePpm: component.ratePpm,
              displayOrder: index,
            },
            select: { id: true },
          });
          await tx.locationTaxComponentClass.createMany({
            data: component.taxClassIds.map((taxClassId) => ({
              tenantId,
              componentId: row.id,
              taxClassId,
            })),
          });
        }

        await this.audit.recordTaxSettingsAction(tx, {
          actorInternalUserId,
          action: 'tax.location_draft_saved',
          targetType: 'location',
          targetId: locationId,
          afterData: {
            versionId: draft.id,
            components: auditComponents(components),
          },
        });
        return this.locationResponse(tx, tenantId, locationId);
      }),
    );
  }

  async discardDraft(
    tenantId: string,
    actorInternalUserId: string,
    locationId: string,
  ): Promise<AdminLocationTaxResponse> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockLocation(tx, tenantId, locationId);
      const draft = await tx.locationTaxVersion.findFirst({
        where: { tenantId, locationId, status: 'DRAFT' },
        select: { id: true, version: true },
      });
      if (!draft) throw new NotFoundException('There is no draft to discard.');
      await tx.locationTaxComponentClass.deleteMany({
        where: { tenantId, component: { tenantId, versionId: draft.id } },
      });
      await tx.locationTaxComponent.deleteMany({
        where: { tenantId, versionId: draft.id },
      });
      await tx.locationTaxVersion.delete({
        where: { tenantId_id: { tenantId, id: draft.id } },
      });
      await this.audit.recordTaxSettingsAction(tx, {
        actorInternalUserId,
        action: 'tax.location_draft_discarded',
        targetType: 'location',
        targetId: locationId,
        beforeData: { versionId: draft.id, version: draft.version },
      });
      return this.locationResponse(tx, tenantId, locationId);
    });
  }

  // Confirms exactly the draft the administrator reviewed. Refused while any
  // active category has not been explicitly classified. The previous
  // confirmed version becomes SUPERSEDED (kept).
  async confirmDraft(
    tenantId: string,
    actorInternalUserId: string,
    locationId: string,
    body: unknown,
  ): Promise<AdminLocationTaxResponse> {
    const input = (body ?? {}) as Record<string, unknown>;
    const draftId = requiredId(
      input.draftId,
      'The draft to confirm is missing.',
    );
    const draftUpdatedAt =
      typeof input.draftUpdatedAt === 'string' ? input.draftUpdatedAt : null;
    if (!draftUpdatedAt) {
      throw new BadRequestException('The draft to confirm is missing.');
    }

    await this.ensureDefaultClass(this.prisma, tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockLocation(tx, tenantId, locationId);
      const draft = await tx.locationTaxVersion.findFirst({
        where: { tenantId, locationId, status: 'DRAFT' },
        include: VERSION_INCLUDE,
      });
      if (
        !draft ||
        draft.id !== draftId ||
        draft.updatedAt.toISOString() !== draftUpdatedAt
      ) {
        throw new ConflictException({
          code: TAX_DRAFT_CHANGED,
          message:
            'These tax settings changed since you reviewed them. Review them again before confirming.',
        });
      }
      const unreviewed = await tx.category.count({
        where: { tenantId, isActive: true, taxClassReviewedAt: null },
      });
      if (unreviewed > 0) {
        throw new ConflictException({
          code: TAX_CATEGORIES_UNREVIEWED,
          message: `Review the tax class of every active category first (${unreviewed} still to review).`,
        });
      }

      const now = new Date();
      const previous = await tx.locationTaxVersion.findFirst({
        where: { tenantId, locationId, status: 'CONFIRMED' },
        select: { id: true, version: true },
      });
      if (previous) {
        await tx.locationTaxVersion.update({
          where: { tenantId_id: { tenantId, id: previous.id } },
          data: { status: 'SUPERSEDED', supersededAt: now },
        });
      }
      await tx.locationTaxVersion.update({
        where: { tenantId_id: { tenantId, id: draft.id } },
        data: {
          status: 'CONFIRMED',
          confirmedAt: now,
          confirmedByInternalUserId: actorInternalUserId,
        },
      });
      await this.audit.recordTaxSettingsAction(tx, {
        actorInternalUserId,
        action: 'tax.location_confirmed',
        targetType: 'location',
        targetId: locationId,
        beforeData: previous
          ? { versionId: previous.id, version: previous.version }
          : undefined,
        afterData: {
          versionId: draft.id,
          version: draft.version,
          components: draft.components.map((component) => ({
            name: component.name,
            jurisdiction: component.jurisdiction,
            ratePpm: component.ratePpm,
            taxClassIds: component.classes.map((link) => link.taxClassId),
          })),
        },
      });
      return this.locationResponse(tx, tenantId, locationId);
    });
  }

  // --- helpers ----------------------------------------------------------------

  // The business's default class (Prepared Food), created on first use. Safe
  // under concurrency: the per-business unique key makes a second insert a
  // no-op.
  private async ensureDefaultClass(
    db: Db,
    tenantId: string,
  ): Promise<{ id: string }> {
    const existing = await db.taxClass.findUnique({
      where: {
        tenantId_systemKey: { tenantId, systemKey: DEFAULT_SYSTEM_KEY },
      },
      select: { id: true },
    });
    if (existing) return existing;
    await db.taxClass.createMany({
      data: [
        {
          tenantId,
          name: DEFAULT_TAX_CLASS_NAME,
          systemKey: DEFAULT_SYSTEM_KEY,
        },
      ],
      skipDuplicates: true,
    });
    return db.taxClass.findUniqueOrThrow({
      where: {
        tenantId_systemKey: { tenantId, systemKey: DEFAULT_SYSTEM_KEY },
      },
      select: { id: true },
    });
  }

  private async classes(db: Db, tenantId: string): Promise<AdminTaxClass[]> {
    const rows = await db.taxClass.findMany({
      where: { tenantId },
      orderBy: [{ systemKey: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      select: { id: true, name: true, systemKey: true },
    });
    return rows.map(toClass);
  }

  private async assertClassExists(
    db: Db,
    tenantId: string,
    taxClassId: string,
  ): Promise<void> {
    const found = await db.taxClass.findFirst({
      where: { tenantId, id: taxClassId },
      select: { id: true },
    });
    if (!found)
      throw new BadRequestException('Choose a tax class from this list.');
  }

  // Serializes every change to one location's tax settings (and proves the
  // location belongs to this business).
  private async lockLocation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Location"
       WHERE "tenantId" = ${tenantId} AND "id" = ${locationId}
       FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Location not found.');
  }

  private async locationResponse(
    db: Db,
    tenantId: string,
    locationId: string,
  ): Promise<AdminLocationTaxResponse> {
    const location = await db.location.findFirst({
      where: { tenantId, id: locationId },
      select: { id: true, name: true, region: true },
    });
    if (!location) throw new NotFoundException('Location not found.');
    const [classes, versions, unreviewed] = await Promise.all([
      this.classes(db, tenantId),
      db.locationTaxVersion.findMany({
        where: { tenantId, locationId },
        orderBy: { version: 'desc' },
        include: VERSION_INCLUDE,
      }),
      db.category.count({
        where: { tenantId, isActive: true, taxClassReviewedAt: null },
      }),
    ]);
    const confirmed = versions.find((v) => v.status === 'CONFIRMED') ?? null;
    const draft = versions.find((v) => v.status === 'DRAFT') ?? null;
    return {
      location,
      classes,
      confirmed: confirmed ? toVersion(confirmed) : null,
      draft: draft ? toVersion(draft) : null,
      history: versions.filter((v) => v.status === 'SUPERSEDED').map(toVersion),
      unreviewedActiveCategories: unreviewed,
    };
  }

  private async uniqueName<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: TAX_CLASS_NAME_TAKEN,
          message: 'A tax class with this name already exists.',
        });
      }
      throw error;
    }
  }

  // Two first drafts for one location at the same moment: the second is
  // refused by the one-draft-per-location index.
  private async draftConflict<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: TAX_DRAFT_CHANGED,
          message:
            'These tax settings were changed at the same time. Reload and try again.',
        });
      }
      throw error;
    }
  }
}

// --- pure helpers ---------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function toClass(row: {
  id: string;
  name: string;
  systemKey: string | null;
}): AdminTaxClass {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.systemKey === DEFAULT_SYSTEM_KEY,
  };
}

function toVersion(row: VersionRow): AdminTaxVersion {
  return {
    id: row.id,
    version: row.version,
    status: row.status as TaxVersionStatus,
    source: 'BUILT_IN',
    pricesIncludeTax: false,
    components: row.components.map((component) => ({
      id: component.id,
      name: component.name,
      jurisdiction: component.jurisdiction as TaxJurisdiction,
      ratePpm: component.ratePpm,
      ratePercent: formatTaxRatePpm(component.ratePpm),
      taxClassIds: component.classes.map((link) => link.taxClassId).sort(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmedByName: row.confirmedBy
      ? (row.confirmedBy.displayName ?? row.confirmedBy.email)
      : null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
  };
}

function className(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > TAX_CLASS_NAME_MAX) {
    throw new BadRequestException(
      `Enter a tax class name of 1 to ${TAX_CLASS_NAME_MAX} characters.`,
    );
  }
  return name;
}

function requiredId(raw: unknown, message: string): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 64) {
    throw new BadRequestException(message);
  }
  return raw;
}

export function parseComponents(raw: unknown): ParsedComponent[] {
  if (!Array.isArray(raw)) {
    throw new BadRequestException('Enter the taxes for this location.');
  }
  if (raw.length > TAX_COMPONENTS_MAX) {
    throw new BadRequestException(
      `A location can have at most ${TAX_COMPONENTS_MAX} taxes.`,
    );
  }
  return raw.map((item: unknown, index) => {
    const position = `Tax ${index + 1}`;
    const value = (item ?? {}) as Record<string, unknown>;
    const name =
      typeof value.name === 'string'
        ? value.name.trim().replace(/\s+/g, ' ')
        : '';
    if (name.length < 1 || name.length > TAX_COMPONENT_NAME_MAX) {
      throw new BadRequestException(
        `${position}: enter a name of 1 to ${TAX_COMPONENT_NAME_MAX} characters.`,
      );
    }
    const jurisdiction = value.jurisdiction;
    if (
      typeof jurisdiction !== 'string' ||
      !(TAX_JURISDICTIONS as readonly string[]).includes(jurisdiction)
    ) {
      throw new BadRequestException(
        `${position}: choose state, county, city or special district.`,
      );
    }
    const rate = parseTaxRatePercent(value.ratePercent);
    if (!rate.ok) throw new BadRequestException(`${position}: ${rate.error}`);
    const ids = value.taxClassIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.some(
        (id) => typeof id !== 'string' || id.length < 1 || id.length > 64,
      )
    ) {
      throw new BadRequestException(
        `${position}: choose at least one tax class it applies to.`,
      );
    }
    return {
      name,
      jurisdiction: jurisdiction as TaxJurisdiction,
      ratePpm: rate.ratePpm,
      taxClassIds: [...new Set(ids as string[])],
    };
  });
}

function auditComponents(components: ParsedComponent[]) {
  return components.map((component) => ({
    name: component.name,
    jurisdiction: component.jurisdiction,
    ratePpm: component.ratePpm,
    taxClassIds: component.taxClassIds,
  }));
}
