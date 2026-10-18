import { DEFAULT_LOYALTY_POINTS_LABEL } from "@mocha-house/contracts";

// SC4f-3b — a business's name for its loyalty points, in wording. The label
// is plural ("Points", "Mocha Beans", "Stars"); a single unit drops a final
// "s" ("1 Point", "Bonus Mocha Bean Promotion"), except where the word only
// looks plural. Presentation only.

export function pointsLabelOrDefault(label: string | null | undefined): string {
  const trimmed = typeof label === "string" ? label.trim() : "";
  return trimmed === "" ? DEFAULT_LOYALTY_POINTS_LABEL : trimmed;
}

export function singularPoints(label: string): string {
  // Words that only look plural (Bonus, Kudos, Plus, Chess) stay as they are.
  return label.length > 1 && /[sS]$/.test(label) && !/(ss|us|is|os)$/i.test(label)
    ? label.slice(0, -1)
    : label;
}

// "12 Points", "1 Point".
export function pointsCount(count: number, label: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singularPoints(label) : label}`;
}
