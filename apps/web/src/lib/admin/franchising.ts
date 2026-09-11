import type {
  AdminFranchiseInquiryActivityItem,
  FranchiseInquiryStatus,
} from "@mocha-house/contracts";
import { FRANCHISE_INQUIRY_STATUSES } from "@mocha-house/contracts";

// Plain-language presentation helpers for Admin → Franchising (Milestone
// 8D). Read-only: the API is the authority for every value and re-checks
// every permission. Status moves through the dedicated
// `POST /inquiries/:id/status` action — there is no transition graph, so
// every status is offered as a target.

const STATUS_LABEL: Record<FranchiseInquiryStatus, string> = {
  NEW: "New",
  REVIEWING: "Reviewing",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CLOSED: "Closed",
};

export function inquiryStatusLabel(status: FranchiseInquiryStatus): string {
  return STATUS_LABEL[status];
}

// Maps to the shared StatusBadge tones.
export function inquiryStatusTone(
  status: FranchiseInquiryStatus,
): "neutral" | "positive" | "warning" {
  if (status === "QUALIFIED") {
    return "positive";
  }
  if (status === "CLOSED") {
    return "neutral";
  }
  return "warning";
}

export const INQUIRY_STATUS_OPTIONS: {
  value: FranchiseInquiryStatus;
  label: string;
}[] = FRANCHISE_INQUIRY_STATUSES.map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));

export function prospectName(firstName: string, lastName: string): string {
  const name = `${firstName} ${lastName}`.trim();
  return name.length > 0 ? name : "Prospect";
}

// A short "Jan 5, 2026" date for list / timeline rows.
export function formatInquiryDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// One rendered line for the activity timeline: the summary, plus the actor
// when known, plus the date. Never contains prospect answers / PII.
export function inquiryActivityLine(
  item: AdminFranchiseInquiryActivityItem,
): string {
  const actor = item.actorLabel ? ` by ${item.actorLabel}` : "";
  return `${item.summary}${actor} · ${formatInquiryDate(item.createdAt)}`;
}
