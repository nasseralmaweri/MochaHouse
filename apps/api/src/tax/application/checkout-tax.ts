import { createHash } from 'node:crypto';
import {
  formatTaxRatePpm,
  type CheckoutQuoteTax,
  type OrderTaxSummary,
  type TaxComponentAmount,
  type TaxJurisdiction,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RegularDiscountPlan } from '../../promotions/application/promotion-checkout.service';
import type { RedemptionPlan } from '../../loyalty/application/loyalty-redemption.service';
import {
  TaxCalculationError,
  assertTaxResultReconciles,
  type TaxCalculationComponent,
  type TaxCalculationDiscount,
  type TaxCalculationResult,
} from '../domain/tax-calculation';
import type { SalesTaxProvider } from './sales-tax-provider';

// V1 Sales Tax PR 2 — sales tax at checkout. Reads the location's CONFIRMED
// tax settings and each product's tax class (its own override, else its
// category's, else the business's default class, Prepared Food), maps the
// checkout's store-funded discounts onto its lines, and asks the provider to
// calculate. The result is frozen with the checkout before the customer is
// charged and re-verified, exactly, before the order is created.

type Db = Prisma.TransactionClient | PrismaService;

// What a checkout freezes about its tax (inside the version-3 frozen
// checkout). Enough to repeat the calculation exactly and to snapshot it.
export interface FrozenTax {
  taxVersionId: string;
  taxVersion: number;
  source: 'BUILT_IN';
  // The tax classes as they were named at checkout.
  classes: { id: string; name: string }[];
  // The confirmed components, in their display order.
  components: TaxCalculationComponent[];
  // Each frozen line's tax class, by position.
  lineTaxClassIds: string[];
  result: TaxCalculationResult;
}

export class TaxNotConfiguredError extends Error {
  constructor() {
    super('This location has no confirmed sales tax settings.');
    this.name = 'TaxNotConfiguredError';
  }
}

export class FrozenTaxMismatchError extends Error {
  constructor(reason: string) {
    super(`The frozen sales tax does not verify (${reason}).`);
    this.name = 'FrozenTaxMismatchError';
  }
}

interface ConfirmedRules {
  taxVersionId: string;
  taxVersion: number;
  components: TaxCalculationComponent[];
}

// The store-funded discounts, as the tax calculation allocates them: a freed
// unit on its own line; a targeted promotion pro rata over the lines of its
// eligible products; an order-wide promotion or a fixed Mocha Bean reward
// pro rata over every line. The regular promotion comes first, then the
// reward — the order in which checkout applies them.
export function taxDiscountsFor(
  lines: { productId: string }[],
  regularPlan: RegularDiscountPlan | null,
  rewardPlan: RedemptionPlan | null,
): TaxCalculationDiscount[] {
  const discounts: TaxCalculationDiscount[] = [];
  if (regularPlan !== null && regularPlan.discountMinorUnits > 0) {
    if (regularPlan.discountType === 'FREE_ITEM') {
      if (!regularPlan.freeItem) throw new TaxCalculationError('free item');
      discounts.push({
        kind: 'PROMOTION',
        funding: 'STORE',
        amount: regularPlan.discountMinorUnits,
        allocation: { type: 'LINE', lineIndex: regularPlan.freeItem.lineIndex },
      });
    } else {
      const eligible = regularPlan.discountEligibleProductIds;
      discounts.push({
        kind: 'PROMOTION',
        funding: 'STORE',
        amount: regularPlan.discountMinorUnits,
        allocation: {
          type: 'PRO_RATA',
          eligibleLineIndices:
            eligible === null
              ? null
              : lines
                  .map((line, i) =>
                    eligible.includes(line.productId) ? i : -1,
                  )
                  .filter((i) => i >= 0),
        },
      });
    }
  }
  if (rewardPlan !== null && rewardPlan.discountMinorUnits > 0) {
    if (rewardPlan.rewardType === 'FREE_ITEM') {
      if (!rewardPlan.freeItem) throw new TaxCalculationError('free item');
      discounts.push({
        kind: 'REWARD',
        funding: 'STORE',
        amount: rewardPlan.discountMinorUnits,
        allocation: { type: 'LINE', lineIndex: rewardPlan.freeItem.lineIndex },
      });
    } else {
      discounts.push({
        kind: 'REWARD',
        funding: 'STORE',
        amount: rewardPlan.discountMinorUnits,
        allocation: { type: 'PRO_RATA', eligibleLineIndices: null },
      });
    }
  }
  return discounts;
}

export class SalesTaxService {
  constructor(private readonly provider: SalesTaxProvider) {}

  // The location's confirmed tax version, or null when it has none.
  async confirmedRules(
    db: Db,
    tenantId: string,
    locationId: string,
  ): Promise<ConfirmedRules | null> {
    const version = await db.locationTaxVersion.findFirst({
      where: { tenantId, locationId, status: 'CONFIRMED' },
      select: {
        id: true,
        version: true,
        components: {
          orderBy: { displayOrder: 'asc' },
          select: {
            id: true,
            name: true,
            jurisdiction: true,
            ratePpm: true,
            classes: {
              select: { taxClassId: true },
              orderBy: { taxClassId: 'asc' },
            },
          },
        },
      },
    });
    if (!version) return null;
    return {
      taxVersionId: version.id,
      taxVersion: version.version,
      components: version.components.map((c) => ({
        componentId: c.id,
        name: c.name,
        jurisdiction: c.jurisdiction,
        ratePpm: c.ratePpm,
        taxClassIds: c.classes.map((k) => k.taxClassId),
      })),
    };
  }

  // The tax on a checkout. Throws TaxNotConfiguredError when the location
  // has no confirmed settings.
  async planCheckoutTax(
    db: Db,
    input: {
      tenantId: string;
      locationId: string;
      currency: string;
      lines: { productId: string; lineTotal: number }[];
      regularPlan: RegularDiscountPlan | null;
      rewardPlan: RedemptionPlan | null;
    },
  ): Promise<FrozenTax> {
    const { tenantId } = input;
    const rules = await this.confirmedRules(db, tenantId, input.locationId);
    if (!rules) throw new TaxNotConfiguredError();

    const productIds = [...new Set(input.lines.map((l) => l.productId))];
    const [products, classes] = await Promise.all([
      db.product.findMany({
        where: { tenantId, id: { in: productIds } },
        select: {
          id: true,
          taxClassId: true,
          category: { select: { taxClassId: true } },
        },
      }),
      db.taxClass.findMany({
        where: { tenantId },
        select: { id: true, name: true, systemKey: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    const defaultClass = classes.find((c) => c.systemKey === 'PREPARED_FOOD');
    if (!defaultClass) throw new TaxNotConfiguredError();
    const classOf = new Map(
      products.map((p) => [
        p.id,
        p.taxClassId ?? p.category.taxClassId ?? defaultClass.id,
      ]),
    );
    const lineTaxClassIds = input.lines.map((line) => {
      const taxClassId = classOf.get(line.productId);
      if (!taxClassId) throw new TaxCalculationError('product');
      return taxClassId;
    });

    const result = this.provider.calculate({
      currency: input.currency,
      lines: input.lines.map((line, i) => ({
        lineIndex: i,
        productId: line.productId,
        lineTotal: line.lineTotal,
        taxClassId: lineTaxClassIds[i],
      })),
      discounts: taxDiscountsFor(
        input.lines,
        input.regularPlan,
        input.rewardPlan,
      ),
      components: rules.components,
    });
    return {
      taxVersionId: rules.taxVersionId,
      taxVersion: rules.taxVersion,
      source: this.provider.source,
      classes: classes.map((c) => ({ id: c.id, name: c.name })),
      components: rules.components,
      lineTaxClassIds,
      result,
    };
  }

  // Repeats a frozen calculation from its own frozen inputs and requires the
  // identical result, and agreement with the frozen order it belongs to.
  verifyFrozenTax(
    tax: FrozenTax,
    frozen: {
      currency: string;
      lines: { productId: string; lineTotal: number }[];
      regularPlan: RegularDiscountPlan | null;
      rewardPlan: RedemptionPlan | null;
      totals: { promotionDiscount: number; rewardDiscount: number };
    },
  ): void {
    const fail = (reason: string): never => {
      throw new FrozenTaxMismatchError(reason);
    };
    if (tax.source !== this.provider.source) fail('source');
    if (tax.lineTaxClassIds.length !== frozen.lines.length) fail('lines');
    let repeated: TaxCalculationResult;
    try {
      assertTaxResultReconciles(tax.result);
      repeated = this.provider.calculate({
        currency: frozen.currency,
        lines: frozen.lines.map((line, i) => ({
          lineIndex: i,
          productId: line.productId,
          lineTotal: line.lineTotal,
          taxClassId: tax.lineTaxClassIds[i],
        })),
        discounts: taxDiscountsFor(
          frozen.lines,
          frozen.regularPlan,
          frozen.rewardPlan,
        ),
        components: tax.components,
      });
    } catch (error) {
      if (error instanceof TaxCalculationError) fail(error.message);
      throw error;
    }
    if (!sameValue(repeated!, tax.result)) fail('calculation');
    if (
      tax.result.discountMinorUnits !==
      frozen.totals.promotionDiscount + frozen.totals.rewardDiscount
    ) {
      fail('discounts');
    }
  }
}

// Structural equality (object key order ignored: the frozen checkout is
// stored as JSONB, which does not keep it; array order matters).
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) {
    return false;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return (
    ka.length === kb.length &&
    ka.every(
      (k, i) =>
        k === kb[i] &&
        sameValue(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}

// --- presentation ---------------------------------------------------------

function componentAmounts(result: TaxCalculationResult): TaxComponentAmount[] {
  return result.components.map((c) => ({
    name: c.name,
    jurisdiction: c.jurisdiction as TaxJurisdiction,
    ratePercent: formatTaxRatePpm(c.ratePpm),
    taxableMinorUnits: c.taxableMinorUnits,
    taxMinorUnits: c.taxMinorUnits,
  }));
}

// PR #94 review — a digest of everything that decides a cart's tax: the
// tax version and its components, each line's tax class (a category class or
// product override can change without a new version), and the resulting
// tax per component and per line. Quote and checkout compute it the same
// way; any difference means the customer has not reviewed this tax.
export function taxQuoteToken(tax: FrozenTax): string {
  const material = [
    1,
    tax.taxVersionId,
    tax.taxVersion,
    tax.source,
    tax.result.currency,
    tax.components.map((c) => [c.componentId, c.ratePpm, c.taxClassIds]),
    tax.lineTaxClassIds,
    tax.result.lines.map((l) => [
      l.productId,
      l.taxableMinorUnits,
      l.componentTax,
    ]),
    tax.result.components.map((c) => [c.taxableMinorUnits, c.taxMinorUnits]),
    tax.result.taxMinorUnits,
  ];
  return `tq1_${createHash('sha256').update(JSON.stringify(material)).digest('base64url')}`;
}

export function toQuoteTax(tax: FrozenTax): CheckoutQuoteTax {
  return {
    taxMinorUnits: tax.result.taxMinorUnits,
    taxQuoteToken: taxQuoteToken(tax),
    taxVersionId: tax.taxVersionId,
    taxVersion: tax.taxVersion,
    components: componentAmounts(tax.result),
  };
}

// The snapshot's `detail`: the complete calculation, with names as they
// were at checkout.
export function orderTaxDetail(
  tax: FrozenTax,
  lineNames: string[],
): Prisma.InputJsonValue {
  const className = new Map(tax.classes.map((c) => [c.id, c.name]));
  return {
    calculationVersion: tax.result.calculationVersion,
    classes: tax.classes,
    discounts: tax.result.discounts,
    components: tax.result.components.map((c) => ({
      ...c,
      ratePercent: formatTaxRatePpm(c.ratePpm),
      taxClassNames: c.taxClassIds.map((id) => className.get(id) ?? id),
    })),
    lines: tax.result.lines.map((line) => ({
      ...line,
      productName: lineNames[line.lineIndex] ?? '',
      taxClassName: className.get(line.taxClassId) ?? line.taxClassId,
    })),
  };
}

// The customer / staff view of an order's tax, from its snapshot.
export function toOrderTaxSummary(
  snapshot: {
    taxMinorUnits: number;
    taxVersion: number;
    detail: Prisma.JsonValue;
  } | null,
): OrderTaxSummary | null {
  if (!snapshot) return null;
  const detail = snapshot.detail as unknown as {
    components?: {
      name: string;
      jurisdiction: string;
      ratePpm: number;
      taxableMinorUnits: number;
      taxMinorUnits: number;
    }[];
    lines?: { taxMinorUnits: number }[];
  };
  return {
    taxMinorUnits: snapshot.taxMinorUnits,
    taxVersion: snapshot.taxVersion,
    components: (detail.components ?? []).map((c) => ({
      name: c.name,
      jurisdiction: c.jurisdiction as TaxJurisdiction,
      ratePercent: formatTaxRatePpm(c.ratePpm),
      taxableMinorUnits: c.taxableMinorUnits,
      taxMinorUnits: c.taxMinorUnits,
    })),
    lineTaxMinorUnits: (detail.lines ?? []).map((l) => l.taxMinorUnits),
  };
}

// Reads a frozen tax block (version-3 frozen checkout) of the exact shape.
export function isFrozenTax(value: unknown): value is FrozenTax {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const isNum = (x: unknown) =>
    typeof x === 'number' && Number.isSafeInteger(x);
  return (
    typeof v.taxVersionId === 'string' &&
    isNum(v.taxVersion) &&
    v.source === 'BUILT_IN' &&
    Array.isArray(v.classes) &&
    v.classes.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as Record<string, unknown>).id === 'string' &&
        typeof (c as Record<string, unknown>).name === 'string',
    ) &&
    Array.isArray(v.components) &&
    v.components.every((c) => {
      const k = c as Record<string, unknown>;
      return (
        typeof k === 'object' &&
        k !== null &&
        typeof k.componentId === 'string' &&
        typeof k.name === 'string' &&
        typeof k.jurisdiction === 'string' &&
        isNum(k.ratePpm) &&
        Array.isArray(k.taxClassIds) &&
        k.taxClassIds.every((id) => typeof id === 'string')
      );
    }) &&
    Array.isArray(v.lineTaxClassIds) &&
    v.lineTaxClassIds.every((id) => typeof id === 'string') &&
    typeof v.result === 'object' &&
    v.result !== null
  );
}
