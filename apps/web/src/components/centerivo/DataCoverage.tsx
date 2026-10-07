import { IconInfo } from "./Icons";

// The CENTERIVO data-coverage pattern: one always-visible line that says what
// a figure does and does not include ("Digital platform orders only"). It is
// deliberately plain text beside the numbers it qualifies — never a tooltip —
// so a figure can't be mistaken for total-business sales.
export function DataCoverage({ items }: { items: string[] }) {
  const shown = items.filter((item) => item.trim().length > 0);
  if (shown.length === 0) return null;
  return (
    <p className="flex items-start gap-2 text-[0.8125rem] leading-snug text-text-secondary">
      <IconInfo className="mt-px h-3.5 w-3.5 text-text-muted" />
      <span>{shown.join(" · ")}</span>
    </p>
  );
}
