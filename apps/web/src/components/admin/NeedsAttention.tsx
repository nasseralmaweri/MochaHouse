import Link from "next/link";
import { Card } from "@/components/Card";

export interface AttentionItem {
  id: string;
  // Milestone 5C only surfaces "warning" (digital ordering disabled) and
  // "info". No fabricated "critical" severity — there is no data source for
  // one yet.
  severity: "info" | "warning";
  title: string;
  description: string;
  // Omitted in 5C where the responsible module doesn't exist yet.
  href?: string;
}

const SEVERITY_LABEL: Record<AttentionItem["severity"], string> = {
  info: "Info",
  warning: "Needs attention",
};

const SEVERITY_DOT: Record<AttentionItem["severity"], string> = {
  info: "bg-status-info",
  warning: "bg-status-warning",
};

// The reusable "what needs my attention right now" list. Text labels always
// accompany the severity colour.
export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <Card
        tone="subtle"
        className="flex items-center gap-2 text-sm text-text-secondary"
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-status-success"
        />
        <span>Nothing needs your attention right now.</span>
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => {
        const body = (
          <Card className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`}
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {SEVERITY_LABEL[item.severity]}
              </span>
              <span className="text-sm font-semibold text-text-primary">
                {item.title}
              </span>
              <span className="text-sm text-text-secondary">
                {item.description}
              </span>
            </div>
          </Card>
        );

        return (
          <li key={item.id}>
            {item.href ? (
              <Link
                href={item.href}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
