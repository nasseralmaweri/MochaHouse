import {
  calculateSalesTax,
  type TaxCalculationInput,
  type TaxCalculationResult,
} from '../domain/tax-calculation';

// V1 Sales Tax PR 2 — the seam for a future tax provider. Checkout asks a
// SalesTaxProvider to calculate the tax on an order from the location's
// confirmed rules; V1 has exactly one, the built-in calculation. A future
// provider (with its own source value on the tax version and the order's
// snapshot) implements the same interface, and the result is frozen,
// re-verified and snapshotted exactly the same way.
export interface SalesTaxProvider {
  readonly source: 'BUILT_IN';
  calculate(input: TaxCalculationInput): TaxCalculationResult;
}

export const SALES_TAX_PROVIDER = Symbol('SALES_TAX_PROVIDER');

export const BUILT_IN_SALES_TAX_PROVIDER: SalesTaxProvider = {
  source: 'BUILT_IN',
  calculate: calculateSalesTax,
};

// OFF unless SALES_TAX_ENABLED is exactly "1" (read per request, like the
// order-closure switch). Off: checkout charges exactly as before, with no
// tax. On: every new checkout needs the location's confirmed tax settings
// (a confirmed zero-tax location charges zero tax). Orders already paid are
// always created with the tax they were charged, whatever the switch says.
export function isSalesTaxEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SALES_TAX_ENABLED?.trim() === '1';
}
