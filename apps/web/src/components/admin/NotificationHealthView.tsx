import type {
  NotificationHealthItem,
  NotificationHealthResponse,
} from "@mocha-house/contracts";
import { Card } from "@/components/Card";
import {
  ITEM_STATE_LABEL,
  STATUS_PRESENTATION,
  TONE_CLASSES,
  eventTypeLabel,
  formatAge,
  reasonWithCode,
  severityTone,
} from "@/lib/admin/notification-health";

// R1 / S4c — read-only notification health. A server component: no client
// state, no actions (no re-send, no re-drive). Refreshing is reloading the page.
// Shows counts, ages, machine-readable reasons and the customer-visible order
// number only: no email addresses, tokens or message text ever reach it.

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <span className="text-2xl font-semibold text-text-primary">{value}</span>
      {hint ? <span className="text-xs text-text-secondary">{hint}</span> : null}
    </Card>
  );
}

function Pill({ tone, children }: { tone: keyof typeof TONE_CLASSES; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ItemRow({ item }: { item: NotificationHealthItem }) {
  return (
    <tr className="border-t border-border-default align-top">
      <td className="py-2 pr-3 text-sm text-text-primary">
        {item.reference ? <span className="font-medium">#{item.reference}</span> : "—"}
        <span className="block text-xs text-text-secondary">
          {eventTypeLabel(item.eventType)}
        </span>
      </td>
      <td className="py-2 pr-3">
        <Pill tone={item.state === "retrying" ? "warning" : "critical"}>
          {ITEM_STATE_LABEL[item.state]}
        </Pill>
      </td>
      <td className="py-2 pr-3 text-sm text-text-secondary">
        {reasonWithCode(item.reasonCode)}
        {item.possibleDuplicate ? (
          <span className="block text-xs">May have been sent twice</span>
        ) : null}
      </td>
      <td className="py-2 pr-3 text-sm text-text-secondary">{item.attempts}</td>
      <td className="py-2 text-sm text-text-secondary">
        {item.state === "dead-lettered"
          ? `Gave up ${when(item.failedAt)}`
          : `Created ${when(item.createdAt)}`}
      </td>
    </tr>
  );
}

export function NotificationHealthView({
  health,
}: {
  health: NotificationHealthResponse;
}) {
  const presentation = STATUS_PRESENTATION[health.status];
  const { pending, failed, accepted } = health;

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-2" >
        <div className="flex flex-wrap items-center gap-3">
          <Pill tone={presentation.tone}>{presentation.label}</Pill>
          <span className="text-xs text-text-muted">
            As of {when(health.generatedAt)} · reload the page to refresh
          </span>
        </div>
        <p className="text-sm text-text-secondary">{presentation.summary}</p>
      </Card>

      {health.attention.length > 0 ? (
        <section aria-labelledby="attention-heading" className="flex flex-col gap-3">
          <h2 id="attention-heading" className="text-base font-semibold text-text-primary">
            What needs attention
          </h2>
          <ul className="flex flex-col gap-3">
            {health.attention.map((a) => (
              <li key={a.key}>
                <Card className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={severityTone(a.severity)}>
                      {a.severity === "critical"
                        ? "Act now"
                        : a.severity === "warning"
                          ? "Review"
                          : "For information"}
                    </Pill>
                    <span className="text-sm font-medium text-text-primary">{a.title}</span>
                  </div>
                  <p className="text-sm text-text-secondary">{a.detail}</p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="pipeline-heading" className="flex flex-col gap-3">
        <h2 id="pipeline-heading" className="text-base font-semibold text-text-primary">
          Notifications in progress
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Waiting" value={pending.waiting} hint="Due and about to be sent" />
          <Stat label="Being sent" value={pending.inProgress} hint="A worker has them now" />
          <Stat
            label="Waiting to retry"
            value={pending.scheduledRetry}
            hint="Waiting for their next scheduled attempt"
          />
          <Stat
            label="Not being processed"
            value={pending.delayed}
            hint={`Due for over ${Math.round(health.thresholds.delayedAfterSeconds / 60)} min`}
          />
        </div>
        <Card tone="subtle" className="grid grid-cols-1 gap-2 text-sm text-text-secondary md:grid-cols-3">
          <span>
            Oldest pending: <strong className="text-text-primary">{formatAge(pending.oldestPendingAgeSeconds)}</strong>
          </span>
          <span>
            Oldest retry: <strong className="text-text-primary">{formatAge(pending.oldestRetryingAgeSeconds)}</strong>
          </span>
          <span>
            Longest overdue: <strong className="text-text-primary">{formatAge(pending.oldestOverdueSeconds)}</strong>
          </span>
        </Card>
        {pending.retryReasons.length > 0 ? (
          <p className="text-sm text-text-secondary">
            Why retries are happening:{" "}
            {pending.retryReasons
              .map((r) => `${reasonWithCode(r.code)} × ${r.count}`)
              .join("; ")}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="outcome-heading" className="flex flex-col gap-3">
        <h2 id="outcome-heading" className="text-base font-semibold text-text-primary">
          Outcomes
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Accepted (24 h)"
            value={accepted.last24h}
            hint={`${accepted.last7d} in the last 7 days`}
          />
          <Stat label="Gave up (24 h)" value={failed.last24h} hint="Will not be tried again" />
          <Stat label="Gave up (7 days)" value={failed.last7d} />
          <Stat
            label="May be duplicates (7 days)"
            value={health.possibleDuplicatesLast7d}
            hint="Sent, then retried once"
          />
        </div>
        <p className="text-xs text-text-muted">
          “Accepted” means the email provider took the message. It does not mean it
          reached the customer&apos;s inbox. Orders are never affected by notification
          problems.
        </p>
        {failed.closedDeliberately > 0 ? (
          <p className="text-xs text-text-muted">
            {failed.closedDeliberately} older notification
            {failed.closedDeliberately === 1 ? " was" : "s were"} closed on
            purpose and not sent. These are not failures.
          </p>
        ) : null}
        {failed.reasons.length > 0 ? (
          <p className="text-sm text-text-secondary">
            Why notifications were given up on (7 days):{" "}
            {failed.reasons
              .map((r) => `${reasonWithCode(r.code)} × ${r.count}`)
              .join("; ")}
          </p>
        ) : null}
      </section>

      {health.items.length > 0 ? (
        <section aria-labelledby="items-heading" className="flex flex-col gap-3">
          <h2 id="items-heading" className="text-base font-semibold text-text-primary">
            Notifications to look at
          </h2>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-text-muted">
                  <th className="pb-2 pr-3 font-medium">Order / type</th>
                  <th className="pb-2 pr-3 font-medium">State</th>
                  <th className="pb-2 pr-3 font-medium">Reason</th>
                  <th className="pb-2 pr-3 font-medium">Attempts</th>
                  <th className="pb-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {health.items.map((item) => (
                  <ItemRow key={item.eventId} item={item} />
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-text-muted">
            {health.itemsTruncated
              ? "Showing the most important notifications only. "
              : ""}
            This page is read-only. Re-sending a notification is not available
            here; ask your technical contact to follow the notification runbook.
          </p>
        </section>
      ) : null}
    </div>
  );
}
