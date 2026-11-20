import type {
  OrderTaxSummary,
  TaxComponentAmount,
} from "@mocha-house/contracts";

// V1 Sales Tax PR 2 — how sales tax reads to customers and staff. Every
// amount comes from the server (exact integer minor units); nothing here
// calculates tax.

export const TAX_NOT_CONFIGURED_MESSAGE =
  "This location can't take online orders right now. Please try again later.";

export const CART_TAX_NOTE = "Sales tax, if any, is added at checkout.";

// "Michigan sales tax (6%)".
export function taxLineLabel(
  component: Pick<TaxComponentAmount, "name" | "ratePercent">,
): string {
  return `${component.name} (${component.ratePercent}%)`;
}

// The lines to show for an order's tax: one per tax, or a single "Sales
// tax" line (zero-tax location, or an order without a breakdown). Nothing
// at all for an order from before sales tax.
export function orderTaxLines(
  taxMinorUnits: number,
  tax: OrderTaxSummary | null,
): { label: string; amountMinorUnits: number }[] {
  if (tax === null) {
    return taxMinorUnits > 0
      ? [{ label: "Sales tax", amountMinorUnits: taxMinorUnits }]
      : [];
  }
  if (tax.components.length === 0) {
    return [{ label: "Sales tax", amountMinorUnits: 0 }];
  }
  return tax.components.map((component) => ({
    label: taxLineLabel(component),
    amountMinorUnits: component.taxMinorUnits,
  }));
}
