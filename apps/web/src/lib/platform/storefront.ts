import {
  STOREFRONT_NOT_ELIGIBLE,
  STOREFRONT_PUBLISHING_CHECKS,
  type PlatformStorefrontView,
  type StorefrontHostAction,
  type StorefrontHostKind,
  type StorefrontPublishingCheck,
} from "@mocha-house/contracts";

// SC4f-3a — wording and answer handling for storefront publishing in the
// Platform Console. The API decides everything (permission, recent sign-in,
// eligibility, ownership of addresses); this only presents it.

export const STOREFRONT_MANAGE_PERMISSION = "storefront.manage";

export const CHECK_LABEL: Record<StorefrontPublishingCheck, string> = {
  business_active: "Business is active (not suspended)",
  billing_authorized: "Billing or trial is authorized",
  location_configured: "A location is set up (address, phone, time zone and opening hours)",
  menu_available: "That location has a menu with at least one product customers can buy",
};

export const KIND_LABEL: Record<StorefrontHostKind, string> = {
  PLATFORM_SUBDOMAIN: "Platform address",
  LEGACY: "Existing Mocha House address",
  CUSTOM: "Custom domain",
};

export const ACTION_LABEL: Record<StorefrontHostAction, string> = {
  ASSIGNED: "Assigned",
  PUBLISHED: "Published",
  UNPUBLISHED: "Unpublished",
};

export const PLATFORM_UNAVAILABLE_LABEL: Record<
  NonNullable<PlatformStorefrontView["assignable"]["platformUnavailable"]>,
  string
> = {
  domain_not_configured: "Platform addresses aren't configured for this deployment (STOREFRONT_DOMAIN).",
  slug_not_usable: "This business's slug can't be used as a storefront address.",
  reserved_for_legacy: "This business's platform address is reserved for an existing Mocha House address.",
  already_assigned: "This business already has its platform address.",
  taken: "This business's platform address is already assigned.",
};

export const STOREFRONT_MESSAGES = {
  reason: "Give a reason of 10 to 500 characters.",
  slug: "Type the business's slug exactly to confirm.",
  sessionEnded: "Your console session has ended. Sign in again.",
  reauth: "This change needs a recent sign-in. Sign out and sign in again, then retry — you'll need to enter the reason again.",
  confirmUnpublish: "Confirm that you want to take this address out of service.",
  denied: "Your operator account doesn't have permission to manage storefronts. Ask a CENTERIVO administrator to grant storefront.manage.",
  notFound: "That business or address no longer exists. Reload the page.",
  tooMany: "Too many changes right now. Wait a moment and try again.",
  unavailable: "The storefront change couldn't be made right now. Try again.",
} as const;

// Whether an address is publicly reachable, in words: registry publication
// and actual public routing are different things.
export function liveSummary(
  host: { published: boolean; live: boolean },
  hostRouting: boolean,
): string {
  if (host.live) return "Live";
  if (host.published && !hostRouting) return "Published in the registry — not live (host routing is off)";
  if (host.published) return "Published in the registry — not live right now";
  return "Not published";
}

export type StorefrontOutcome =
  | { kind: "ok"; view: PlatformStorefrontView }
  | { kind: "reauth" }
  | { kind: "error"; message: string };

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

function apiMessage(body: unknown, fallback: string): string {
  const message = field(body, "message");
  return typeof message === "string" ? message.slice(0, 300) : fallback;
}

export function interpretStorefrontChange(status: number | null, body: unknown): StorefrontOutcome {
  if (status === 200 && body && typeof body === "object") {
    return { kind: "ok", view: body as PlatformStorefrontView };
  }
  switch (status) {
    case 400:
      return { kind: "error", message: apiMessage(body, STOREFRONT_MESSAGES.reason) };
    case 401:
      return field(body, "code") === "REAUTHENTICATION_REQUIRED"
        ? { kind: "reauth" }
        : { kind: "error", message: STOREFRONT_MESSAGES.sessionEnded };
    case 403:
      return { kind: "error", message: STOREFRONT_MESSAGES.denied };
    case 404:
      return { kind: "error", message: STOREFRONT_MESSAGES.notFound };
    case 409: {
      if (field(body, "code") === STOREFRONT_NOT_ELIGIBLE) {
        const missing = field(body, "missing");
        const labels = Array.isArray(missing)
          ? STOREFRONT_PUBLISHING_CHECKS.filter((key) => missing.includes(key)).map((key) => CHECK_LABEL[key])
          : [];
        return {
          kind: "error",
          message:
            labels.length > 0
              ? `Not ready to publish. Still needed: ${labels.join("; ")}.`
              : "This business is not ready to publish its storefront.",
        };
      }
      return { kind: "error", message: apiMessage(body, STOREFRONT_MESSAGES.unavailable) };
    }
    case 429:
      return { kind: "error", message: STOREFRONT_MESSAGES.tooMany };
    default:
      return { kind: "error", message: STOREFRONT_MESSAGES.unavailable };
  }
}

export function validReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 10 && trimmed.length <= 500;
}

// Ids sent back to the API in a path: only id-shaped values.
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value);
}
