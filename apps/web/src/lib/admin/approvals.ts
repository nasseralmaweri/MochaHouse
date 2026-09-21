import type { ApprovalStatus } from "@mocha-house/contracts";

// Plain-language presentation helpers for Admin → Approvals (Milestone
// 8J). Read-only: the API is the authority for every value.

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export function approvalStatusLabel(status: ApprovalStatus): string {
  return STATUS_LABEL[status];
}

export function approvalStatusTone(
  status: ApprovalStatus,
): "neutral" | "positive" | "warning" {
  if (status === "APPROVED") {
    return "positive";
  }
  if (status === "REJECTED") {
    return "neutral";
  }
  return "warning";
}

export function formatApprovalDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
