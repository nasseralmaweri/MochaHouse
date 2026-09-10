import type {
  JobEmploymentType,
  JobOpeningLocationRef,
  JobOpeningStatus,
} from "@mocha-house/contracts";

// Plain-language presentation helpers for Careers (Milestone 8B) — shared by
// the Admin screens and the public pages. Read-only; the API is the
// authority for every value.

const STATUS_LABEL: Record<JobOpeningStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export function jobStatusLabel(status: JobOpeningStatus): string {
  return STATUS_LABEL[status];
}

export function jobStatusTone(
  status: JobOpeningStatus,
): "neutral" | "positive" | "warning" {
  if (status === "PUBLISHED") {
    return "positive";
  }
  if (status === "DRAFT") {
    return "warning";
  }
  return "neutral";
}

const EMPLOYMENT_TYPE_LABEL: Record<JobEmploymentType, string> = {
  FULL_TIME: "Full time",
  PART_TIME: "Part time",
  TEMPORARY: "Temporary",
  SEASONAL: "Seasonal",
};

export function employmentTypeLabel(type: JobEmploymentType): string {
  return EMPLOYMENT_TYPE_LABEL[type];
}

export const EMPLOYMENT_TYPE_OPTIONS: {
  value: JobEmploymentType;
  label: string;
}[] = (
  ["FULL_TIME", "PART_TIME", "TEMPORARY", "SEASONAL"] as JobEmploymentType[]
).map((value) => ({ value, label: EMPLOYMENT_TYPE_LABEL[value] }));

// A job is either at a named location or "Corporate" (HQ).
export function jobLocationLabel(
  location: JobOpeningLocationRef | null,
): string {
  return location ? location.name : "Corporate";
}

export function jobLocationLabelFromName(name: string | null): string {
  return name ?? "Corporate";
}

export function formatJobDate(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
