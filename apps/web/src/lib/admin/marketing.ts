import type { CampaignStatus } from "@mocha-house/contracts";

// Plain-language presentation helpers for Marketing Campaigns (Milestone
// 8G). Read-only; the API is the authority for every value.

const STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  ENDED: "Ended",
};

export function campaignStatusLabel(status: CampaignStatus): string {
  return STATUS_LABEL[status];
}

export function campaignStatusTone(
  status: CampaignStatus,
): "neutral" | "positive" | "warning" {
  if (status === "ACTIVE") {
    return "positive";
  }
  if (status === "DRAFT") {
    return "warning";
  }
  return "neutral";
}

// Campaign dates are date-only configuration (stored as UTC midnight) —
// formatted in UTC so e.g. "2026-10-01" always reads as Oct 1, regardless
// of the viewer's local timezone offset.
export function formatCampaignDate(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
