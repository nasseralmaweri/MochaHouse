import type { CmsPageStatus } from "@mocha-house/contracts";

// Plain-language presentation helpers for Admin → Content (Milestone 8E).
// Read-only: the API is the authority for every value. Three states only —
// there is no unpublish, no scheduling, no revisions.
//
//   Draft — Never published        (status DRAFT)
//   Published                      (status PUBLISHED, draft == published)
//   Published — Unpublished changes (status PUBLISHED, draft != published)

export function cmsStatusLabel(
  status: CmsPageStatus,
  hasUnpublishedChanges: boolean,
): string {
  if (status === "DRAFT") {
    return "Draft — Never published";
  }
  return hasUnpublishedChanges ? "Published — Unpublished changes" : "Published";
}

export function cmsStatusTone(
  status: CmsPageStatus,
  hasUnpublishedChanges: boolean,
): "neutral" | "positive" | "warning" {
  if (status === "DRAFT") {
    return "warning";
  }
  return hasUnpublishedChanges ? "warning" : "positive";
}

// A short "Jan 5, 2026" date for list / detail rows.
export function formatCmsDate(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
