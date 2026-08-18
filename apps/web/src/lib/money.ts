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
