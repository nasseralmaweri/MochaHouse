import {
  TAX_COMPONENTS_MAX,
  formatTaxRatePpm,
  parseTaxRatePercent,
  type AdminTaxClass,
  type AdminTaxComponent,
  type AdminTaxLocationSummary,
  type GettingStartedSalesTax,
  type TaxComponentInput,
  type TaxJurisdiction,
} from "@mocha-house/contracts";

// V1 Sales Tax PR 1 — presentation helpers for Admin > Sales tax. Pure
// functions only (unit tested). Rates stay exact integers (parts per
// million); a total is a sum of integers, formatted back exactly.

export const JURISDICTION_LABELS: Record<TaxJurisdiction, string> = {
  STATE: "State",
  COUNTY: "County",
  CITY: "City",
  SPECIAL: "Special district",
};

// V1 Sales Tax PR 2 — whether checkout charges sales tax now.
export function taxPageNote(taxCollectionEnabled: boolean): string {
  return taxCollectionEnabled
    ? "Menu prices don't include tax. Checkout adds each location's confirmed sales tax to every order. A location without confirmed settings can't take online orders."
    : "Menu prices don't include tax. These settings are saved for each location but are not added to orders yet — tax collection will be switched on in a later update.";
}

export function locationTaxStateLabel(
  summary: Pick<AdminTaxLocationSummary, "state" | "hasDraft">,
): { label: string; tone: "neutral" | "positive" | "warning" } {
  if (summary.state === "CONFIRMED") {
    return summary.hasDraft
      ? { label: "Confirmed · changes in draft", tone: "positive" }
      : { label: "Confirmed", tone: "positive" };
  }
  if (summary.state === "DRAFT") {
    return { label: "Draft — not confirmed", tone: "warning" };
  }
  return { label: "Not set up", tone: "warning" };
}

export function ratePercentLabel(ratePpm: number): string {
  return `${formatTaxRatePpm(ratePpm)}%`;
}

// The total rate a tax class pays at a location: the sum of the taxes that
// apply to it (integer ppm, exact).
export function classTotalRatePpm(
  components: ReadonlyArray<Pick<AdminTaxComponent, "ratePpm" | "taxClassIds">>,
  taxClassId: string,
): number {
  return components
    .filter((component) => component.taxClassIds.includes(taxClassId))
    .reduce((sum, component) => sum + component.ratePpm, 0);
}

export function classNameOf(
  classes: readonly AdminTaxClass[],
  id: string,
): string {
  return classes.find((c) => c.id === id)?.name ?? "Unknown class";
}

// The editor's row: what the administrator typed, kept as text.
export interface TaxComponentDraftRow {
  key: string;
  name: string;
  jurisdiction: TaxJurisdiction;
  ratePercent: string;
  taxClassIds: string[];
}

export function rowsFromComponents(
  components: readonly AdminTaxComponent[],
): TaxComponentDraftRow[] {
  return components.map((component) => ({
    key: component.id,
    name: component.name,
    jurisdiction: component.jurisdiction,
    ratePercent: component.ratePercent,
    taxClassIds: [...component.taxClassIds],
  }));
}

export type DraftValidation =
  | { ok: true; components: TaxComponentInput[] }
  | { ok: false; errors: Record<string, string> };

// Checks the rows before saving (the API checks again). Errors are keyed by
// row key.
export function validateDraftRows(
  rows: readonly TaxComponentDraftRow[],
): DraftValidation {
  const errors: Record<string, string> = {};
  if (rows.length > TAX_COMPONENTS_MAX) {
    errors.form = `A location can have at most ${TAX_COMPONENTS_MAX} taxes.`;
  }
  for (const row of rows) {
    if (!row.name.trim()) {
      errors[row.key] = "Enter a name for this tax.";
      continue;
    }
    const rate = parseTaxRatePercent(row.ratePercent);
    if (!rate.ok) {
      errors[row.key] = rate.error;
      continue;
    }
    if (row.taxClassIds.length === 0) {
      errors[row.key] = "Choose at least one tax class this tax applies to.";
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    components: rows.map((row) => ({
      name: row.name.trim(),
      jurisdiction: row.jurisdiction,
      ratePercent: row.ratePercent.trim(),
      taxClassIds: row.taxClassIds,
    })),
  };
}

// The getting-started note (informational; never a step).
export function salesTaxSetupNote(tax: GettingStartedSalesTax): {
  done: boolean;
  text: string;
} {
  if (tax.totalLocations === 0) {
    return {
      done: false,
      text: "Add a location first, then set up its sales tax.",
    };
  }
  if (tax.confirmedLocations >= tax.totalLocations) {
    return {
      done: true,
      text:
        tax.totalLocations === 1
          ? "Your location's sales tax settings are confirmed."
          : `All ${tax.totalLocations} locations have confirmed sales tax settings.`,
    };
  }
  return {
    done: false,
    text: `${tax.confirmedLocations} of ${tax.totalLocations} location${
      tax.totalLocations === 1 ? "" : "s"
    } confirmed. Sales tax isn't charged on orders yet, but it will need to be set up before it is.`,
  };
}

export function taxRefusalMessage(
  status: number | null,
  body: { code?: unknown; message?: unknown } | null,
): string {
  if (status === null) return "Could not reach the server. Please try again.";
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 403) {
    return "Only your business's authorized administrator can manage sales tax.";
  }
  if (typeof body?.message === "string" && body.message) return body.message;
  if (status === 404) return "This item no longer exists. Reload the page.";
  return `Something went wrong (${status}). Please try again.`;
}
