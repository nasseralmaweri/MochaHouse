import type {
  AdminCustomerActivityItem,
  AdminCustomerSummary,
  CustomerAccountStatus,
} from "@mocha-house/contracts";

// Plain-language presentation helpers for Admin → Customers (Milestone 8A).
// Read-only: nothing here implies an action can be taken. The API is the
// authority for every value; these only format it. Customer status and
// email verification are display-only in 8A.

const STATUS_LABEL: Record<CustomerAccountStatus, string> = {
  ACTIVE: "Active",
  RESTRICTED: "Restricted",
  DEACTIVATED: "Deactivated",
};

export function customerStatusLabel(status: CustomerAccountStatus): string {
  return STATUS_LABEL[status];
}

// Maps to the shared StatusBadge tones.
export function customerStatusTone(
  status: CustomerAccountStatus,
): "neutral" | "positive" | "warning" {
  if (status === "ACTIVE") {
    return "positive";
  }
  if (status === "RESTRICTED") {
    return "warning";
  }
  return "neutral";
}

export function emailVerifiedLabel(emailVerified: boolean): string {
  return emailVerified ? "Email verified" : "Email not verified";
}

export function marketingOptInLabel(optIn: boolean): string {
  return optIn ? "Opted in to marketing email" : "Not opted in to marketing email";
}

// The name shown in the directory row / detail header. Falls back to the
// email, then to a shortened id, so a row is never blank.
export function customerDisplayName(customer: AdminCustomerSummary): string {
  if (customer.displayName && customer.displayName.trim().length > 0) {
    return customer.displayName;
  }
  if (customer.email && customer.email.trim().length > 0) {
    return customer.email;
  }
  return `Customer ${customer.id.slice(0, 8)}`;
}

// "$25.00" from integer minor units — kept here so the CRM presenters have
// no dependency on the ordering money helper.
export function formatMinorUnits(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(minorUnits / 100);
}

export function formatBeans(beans: number): string {
  return `${beans.toLocaleString("en-US")} Mocha Bean${beans === 1 ? "" : "s"}`;
}

// A short "Jan 5, 2026" date for timeline / list rows.
export function formatCrmDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// One rendered line for the activity timeline: the summary, plus the actor
// when known, plus the date.
export function activityLine(item: AdminCustomerActivityItem): string {
  const actor = item.actorLabel ? ` by ${item.actorLabel}` : "";
  return `${item.summary}${actor} · ${formatCrmDate(item.createdAt)}`;
}

// Section display order for the Customer Detail page — a single source so
// the page and any future summary read consistently.
export const CRM_DETAIL_SECTIONS = [
  "profile",
  "orders",
  "mochaBeans",
  "affordableRewards",
  "giftCards",
  "preferredLocations",
  "communicationPreferences",
  "notes",
  "activity",
] as const;

export type CrmDetailSection = (typeof CRM_DETAIL_SECTIONS)[number];
