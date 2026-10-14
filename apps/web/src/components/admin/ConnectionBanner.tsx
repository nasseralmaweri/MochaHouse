"use client";

import type { ConnectionState } from "@/lib/polling/polling-controller";
import { describeConnection } from "@/lib/admin/order-queue";
import { Button } from "@/components/admin/Button";

const TONE_CLASS = {
  ok: "border-status-success/30 bg-status-success/10 text-status-success",
  warning: "border-status-warning/30 bg-status-warning/10 text-status-warning",
  danger: "border-status-error/30 bg-status-error/10 text-status-error",
} as const;

function timeLabel(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Shows whether the data on screen is live, recovering, or out of date.
// Only the state text sits in the polite live region, so it is announced when
// the STATE changes — not on every refresh. The "updated at" time is a plain
// element next to it and is never announced.
export function ConnectionBanner({
  connection,
  lastSuccessAt,
  refreshing,
  onRetry,
}: {
  connection: ConnectionState;
  lastSuccessAt: number | null;
  refreshing: boolean;
  onRetry: () => void;
}) {
  const notice = describeConnection(connection);
  const showRetry = notice.tone !== "ok";

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2 text-sm ${TONE_CLASS[notice.tone]}`}
    >
      <span role="status" aria-live="polite" className="font-medium">
        {notice.label}
      </span>
      <span className="flex items-center gap-3">
        {lastSuccessAt !== null ? (
          <span className="text-xs opacity-80">
            Updated {timeLabel(lastSuccessAt)}
            {refreshing ? " · refreshing" : ""}
          </span>
        ) : null}
        {showRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            Retry now
          </Button>
        ) : null}
      </span>
    </div>
  );
}
