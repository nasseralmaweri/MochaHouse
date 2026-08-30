// All prices are integer minor units (cents). Never do business math in
// floating point — only the final display step below converts to a major
// unit, and only for formatting, never for further calculation.
export function formatPrice(
  amountInMinorUnits: number | null,
  currency: string,
): string {
  if (amountInMinorUnits === null) {
    return "Price unavailable";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountInMinorUnits / 100);
}

// --- Admin price entry (Milestone 5D-3) ------------------------------
// Admins work in dollars; the server is authoritative in integer cents.
// These two helpers are the only place the Admin UI crosses that boundary.

// Cents -> the string an Admin sees in the price input (e.g. 350 -> "3.50").
// Empty string for null ("no standard price").
export function centsToDollarInput(cents: number | null): string {
  if (cents === null) {
    return "";
  }
  return (cents / 100).toFixed(2);
}

export type DollarParseResult =
  | { ok: true; cents: number | null }
  | { ok: false; error: string };

// Parse an Admin's dollar entry into integer cents WITHOUT floating-point
// multiplication — the fractional part is read as its own integer and
// combined. An empty entry is a deliberate "no standard price" (null).
// Rejects negatives, more than two decimal places, and anything that isn't
// a plain money amount.
export function parseDollarInput(raw: string): DollarParseResult {
  const cleaned = raw.trim().replace(/^\$/, "").trim();
  if (cleaned === "") {
    return { ok: true, cents: null };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return {
      ok: false,
      error: "Enter an amount like 3.50, or leave it blank for no price.",
    };
  }
  const [wholePart, fractionPart = ""] = cleaned.split(".");
  const cents =
    Number(wholePart) * 100 + Number(fractionPart.padEnd(2, "0"));
  return { ok: true, cents };
}
