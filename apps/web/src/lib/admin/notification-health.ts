import type {
  NotificationAttentionSeverity,
  NotificationHealthItemState,
  NotificationHealthStatus,
} from "@mocha-house/contracts";

// R1 / S4c — presentation helpers for the notification health page. Pure (no
// React, no I/O) so the wording and the age formatting are unit-tested. The
// server decides what needs attention; this only words it.

export type HealthTone = "ok" | "warning" | "critical";

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "under a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

export const STATUS_PRESENTATION: Record<
  NotificationHealthStatus,
  { label: string; summary: string; tone: HealthTone }
> = {
  ok: {
    label: "Working normally",
    summary:
      "Nothing needs attention. Notifications that are waiting or retrying are part of normal operation.",
    tone: "ok",
  },
  warning: {
    label: "Needs a look",
    summary:
      "Something is slower or failing more than usual. Review the items below.",
    tone: "warning",
  },
  critical: {
    label: "Needs attention now",
    summary:
      "Customers or staff may not be receiving notifications. Review the items below.",
    tone: "critical",
  },
};

export function severityTone(severity: NotificationAttentionSeverity): HealthTone | "info" {
  return severity === "info" ? "info" : severity;
}

export const ITEM_STATE_LABEL: Record<NotificationHealthItemState, string> = {
  "dead-lettered": "Gave up",
  delayed: "Not being processed",
  retrying: "Failing repeatedly",
};

const EVENT_TYPE_LABEL: Record<string, string> = {
  "order.checkout.completed": "Order received email",
  "order.status.ready": "Order ready email",
  "careers.application.submitted": "New job application notice",
  "franchising.inquiry.submitted": "New franchise inquiry notice",
};

export function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABEL[eventType] ?? eventType;
}

// Plain-language meaning of the machine-readable reason codes the worker
// records. An unknown code is shown as-is (never hidden) so nothing is lost.
const REASON_LABEL: Record<string, string> = {
  NO_RECIPIENT: "No email address for this order",
  RECIPIENT_NOT_CONFIGURED: "No notification recipient is configured",
  ORDER_NOT_FOUND: "The order could not be found",
  AGGREGATE_NOT_FOUND: "The record could not be found",
  BUSINESS_NAME_MISSING: "Business name missing",
  MESSAGE_REJECTED: "The email provider rejected the message",
  INVALID_PARAMETER_VALUE: "The email provider rejected the message details",
  THROTTLING: "The email provider asked us to slow down",
  SERVICE_UNAVAILABLE: "The email provider is unavailable",
  SES_NOT_CONFIGURED: "The email provider is not configured",
  ECONNREFUSED: "Could not connect to the email provider",
  ENOTFOUND: "Could not find the email provider",
  ACCESS_DENIED: "The email provider refused our credentials",
  EXPIRED_TOKEN: "The email provider credentials expired",
  SEND_TIMEOUT: "The email provider did not answer in time",
  SEND_OUTCOME_UNKNOWN: "The email provider connection failed mid-send",
  ACCEPTANCE_NOT_RECORDED: "Sent, but recording it failed",
  AMBIGUOUS_REPEATED: "Two sends got no answer; not repeated",
  RETRIES_EXHAUSTED: "Tried the maximum number of times",
  EVENT_EXPIRED: "Too old to be worth sending",
  ATTEMPTS_EXCEEDED: "Kept failing before any outcome",
  HISTORICAL_NOT_SENT: "Closed deliberately; not sent",
  TENANT_CONTEXT_INVALID: "Could not be attributed to a business",
  DELIVERY_ALREADY_FAILED: "Already marked as failed",
  RESOLVE_ERROR: "A temporary database problem",
  UNEXPECTED_ERROR: "An unexpected error",
};

export function reasonLabel(code: string | null): string {
  if (!code) return "No reason recorded";
  return REASON_LABEL[code] ?? code;
}

export function reasonWithCode(code: string | null): string {
  if (!code) return reasonLabel(code);
  const label = reasonLabel(code);
  return label === code ? code : `${label} (${code})`;
}

export const TONE_CLASSES: Record<HealthTone | "info", string> = {
  ok: "bg-status-success/10 text-status-success",
  warning: "bg-status-warning/10 text-status-warning",
  critical: "bg-status-error/10 text-status-error",
  info: "bg-surface-subtle text-text-secondary",
};
