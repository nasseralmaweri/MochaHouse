import Link from "next/link";
import type { AttentionItem } from "@/lib/admin/attention";
import { IconAlert, IconArrowRight, IconCheckCircle, IconInfo } from "./Icons";

// The CENTERIVO attention pattern: a compact, prioritised list where each row
// says what needs action, where it applies, how important it is, and links
// straight to the fix. Severity is never colour alone — the icon shape and a
// visible/screen-reader label carry it.
//
// Rows share ONE surface separated by hairlines (not a card per item), so a
// handful of items reads as a list rather than an alert wall. More than
// `max` items collapse behind a native <details>.
const SEVERITY = {
  warning: {
    label: "Needs action",
    icon: IconAlert,
    tone: "bg-status-warning/10 text-status-warning",
    row: "bg-status-warning/[0.035]",
  },
  info: {
    label: "For review",
    icon: IconInfo,
    tone: "bg-status-info/10 text-status-info",
    row: "",
  },
} as const;

function AttentionRow({ item }: { item: AttentionItem }) {
  const meta = SEVERITY[item.severity];
  const Icon = meta.icon;
  const content = (
    <>
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta.tone}`}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-base font-semibold text-text-primary">
            <span className="sr-only">{meta.label}: </span>
            {item.title}
          </span>
          {item.context ? (
            <span className="text-sm text-text-muted">{item.context}</span>
          ) : null}
        </span>
        <span className="text-sm text-text-secondary">{item.description}</span>
      </span>
      {item.href ? (
        <span className="mt-1 flex shrink-0 items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors group-hover:text-accent">
          <span className="hidden sm:inline">
            {item.actionLabel ?? "Review"}
          </span>
          <IconArrowRight className="h-4 w-4" />
        </span>
      ) : null}
    </>
  );

  const rowClass = `group flex items-start gap-4 px-5 py-5 sm:px-6 ${meta.row}`;
  return item.href ? (
    <Link
      href={item.href}
      className={`${rowClass} transition-colors hover:bg-surface-subtle/60 focus-visible:bg-surface-subtle/60`}
    >
      {content}
    </Link>
  ) : (
    <div className={rowClass}>{content}</div>
  );
}

export function AttentionList({
  items,
  max = 5,
  checkedLabel,
  unavailable = [],
  grouped = false,
  quiet = false,
}: {
  items: AttentionItem[];
  max?: number;
  // Render the all-clear state as a single quiet line instead of a card.
  quiet?: boolean;
  // Label the "Needs action" / "For review" groups visibly. Expects items
  // already ordered by prioritizeAttention (warnings first).
  grouped?: boolean;
  // Signals that could not be loaded. They are never reported as "clear".
  unavailable?: string[];
  // What was actually checked, shown in the all-clear state so "nothing
  // needs attention" is a statement about something specific.
  checkedLabel?: string;
}) {
  if (items.length === 0 && unavailable.length > 0) {
    return (
      <div className="flex items-start gap-3.5 rounded-2xl border border-border-default bg-surface-card px-5 py-5 sm:px-6">
        <span className="mt-0.5 text-status-warning">
          <IconAlert className="h-5 w-5" />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="text-[0.9375rem] font-medium text-text-primary">
            Some checks couldn&rsquo;t be completed
          </p>
          <p className="text-sm text-text-secondary">
            Couldn&rsquo;t load: {unavailable.join(", ")}. Refresh to try again.
          </p>
        </div>
      </div>
    );
  }

  if (items.length === 0 && quiet) {
    return (
      <p
        role="status"
        className="flex items-start gap-2.5 rounded-xl border border-border-default bg-surface-card px-4 py-3 text-sm sm:items-center sm:px-5"
      >
        <IconCheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-success sm:mt-0" />
        <span className="text-text-secondary">
          <span className="font-medium text-text-primary">All clear.</span>
          {checkedLabel ? ` Checked ${checkedLabel}.` : " Nothing needs attention."}
        </span>
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex items-start gap-3.5 rounded-2xl border border-border-default bg-surface-card px-5 py-5 sm:px-6">
        <span className="mt-0.5 text-status-success">
          <IconCheckCircle className="h-5 w-5" />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="text-[0.9375rem] font-medium text-text-primary">
            You&rsquo;re all caught up
          </p>
          <p className="text-sm text-text-secondary">
            {checkedLabel
              ? `Nothing needs attention. Checked: ${checkedLabel}.`
              : "Nothing needs attention right now."}
          </p>
        </div>
      </div>
    );
  }

  const visible = items.slice(0, max);
  const rest = items.slice(max);
  const countFor = (severity: AttentionItem["severity"]) =>
    items.filter((item) => item.severity === severity).length;
  return (
    <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-card">
      <ul className="divide-y divide-border-default">
        {visible.map((item, index) => {
          const startsGroup =
            grouped && (index === 0 || visible[index - 1].severity !== item.severity);
          return (
            <li key={item.id}>
              {startsGroup ? (
                <p
                  className={`flex items-center gap-2 px-5 pb-0 pt-3.5 text-xs font-medium uppercase tracking-wide sm:px-6 ${
                    item.severity === "warning"
                      ? "text-status-warning"
                      : "text-text-muted"
                  } ${SEVERITY[item.severity].row}`}
                >
                  {SEVERITY[item.severity].label}
                  <span className="tabular-nums">{countFor(item.severity)}</span>
                </p>
              ) : null}
              <AttentionRow item={item} />
            </li>
          );
        })}
      </ul>
      {unavailable.length > 0 ? (
        <p className="border-t border-border-default px-5 py-3 text-[0.8125rem] text-text-secondary sm:px-6">
          Couldn&rsquo;t load: {unavailable.join(", ")}.
        </p>
      ) : null}
      {rest.length > 0 ? (
        <details className="border-t border-border-default">
          <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary sm:px-6">
            Show {rest.length} more
          </summary>
          <ul className="divide-y divide-border-default border-t border-border-default">
            {rest.map((item) => (
              <li key={item.id}>
                <AttentionRow item={item} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
