import type {
  AdminJobApplicationActivityItem,
  JobApplicationStatus,
} from "@mocha-house/contracts";
import { JOB_APPLICATION_STATUSES } from "@mocha-house/contracts";

// Plain-language presentation helpers for Admin → Careers → Applicants
// (Milestone 8C). Read-only: the API is the authority for every value and
// re-checks every permission. Status moves through the dedicated
// `POST /applications/:id/status` action — there is no transition graph, so
// every status is offered as a target.

const STATUS_LABEL: Record<JobApplicationStatus, string> = {
  NEW: "New",
  REVIEWING: "Reviewing",
  CONTACTED: "Contacted",
  HIRED: "Hired",
  REJECTED: "Rejected",
};

export function applicationStatusLabel(status: JobApplicationStatus): string {
  return STATUS_LABEL[status];
}

// Maps to the shared StatusBadge tones.
export function applicationStatusTone(
  status: JobApplicationStatus,
): "neutral" | "positive" | "warning" {
  if (status === "HIRED") {
    return "positive";
  }
  if (status === "REJECTED") {
    return "neutral";
  }
  return "warning";
}

export const APPLICATION_STATUS_OPTIONS: {
  value: JobApplicationStatus;
  label: string;
}[] = JOB_APPLICATION_STATUSES.map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));

export function applicantName(firstName: string, lastName: string): string {
  const name = `${firstName} ${lastName}`.trim();
  return name.length > 0 ? name : "Applicant";
}

export function workAuthorizedLabel(workAuthorized: boolean): string {
  return workAuthorized
    ? "Legally authorized to work in the U.S."
    : "Not legally authorized to work in the U.S.";
}

// A short "Jan 5, 2026" date for list / timeline rows.
export function formatApplicantDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// One rendered line for the activity timeline: the summary, plus the actor
// when known, plus the date. Never contains applicant answers / PII.
export function applicationActivityLine(
  item: AdminJobApplicationActivityItem,
): string {
  const actor = item.actorLabel ? ` by ${item.actorLabel}` : "";
  return `${item.summary}${actor} · ${formatApplicantDate(item.createdAt)}`;
}
