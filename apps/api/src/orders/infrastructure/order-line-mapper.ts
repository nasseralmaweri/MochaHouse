import type { OrderLineSummary } from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';

// Shared by CheckoutService (confirmation/customer status) and
// AdminOrdersService (store queue) — both surface the same immutable
// OrderLine snapshot, just to different audiences.
export function toOrderLineSummary(line: {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  currency: string;
  selections: Prisma.JsonValue;
}): OrderLineSummary {
  const selections = Array.isArray(line.selections) ? line.selections : [];
  return {
    productId: line.productId,
    productName: line.productName,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    currency: line.currency,
    selections: selections.map((selection) => {
      const s = selection as { groupName: string; optionNames: string[] };
      return { groupName: s.groupName, optionNames: s.optionNames };
    }),
  };
}
