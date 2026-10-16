import type { PlatformTenantSuspensionReason } from "@mocha-house/contracts";

// SC1e — the lifecycle panel's pure logic: what an operator must confirm,
// how a suspension's impact is described (counts only), and how every API
// answer is shown. The API remains the authority.

export const SUSPENSION_REASON_OPTIONS: ReadonlyArray<{
  value: PlatformTenantSuspensionReason;
  label: string;
  hint: string;
}> = [
  { value: "SECURITY", label: "Security", hint: "A security concern with this business's account." },
  { value: "BILLING", label: "Billing", hint: "An unresolved billing matter." },
  { value: "REQUESTED", label: "Requested by the business", hint: "The business asked to pause." },
];

export function isSuspensionReason(value: unknown): value is PlatformTenantSuspensionReason {
  return SUSPENSION_REASON_OPTIONS.some((option) => option.value === value);
}

export const LIFECYCLE_MESSAGES = {
  reauth: "For your security, sign in again to make this change. Changes need a sign-in within the last 15 minutes.",
  sessionEnded: "Your session has ended. Sign in again to continue.",
  denied: "This account is not permitted to change businesses.",
  notFound: "This business could not be found.",
  protected: "This business cannot be suspended from the platform console.",
  ownerSignedIn: "The owner has already signed in, so their email can no longer be corrected here.",
  emailInUse: "Another staff member of this business already uses that email.",
  tooMany: "Too many changes. Wait a few minutes, then try again.",
  unavailable: "The change could not be made right now. Nothing was changed. Try again in a moment.",
  confirmSlug: "Type the business's slug exactly to confirm.",
  chooseReason: "Choose a reason.",
} as const;

// Typed confirmation for a suspension: the slug, exactly (trimmed).
export function confirmsSlug(typed: string, slug: string): boolean {
  return typed.trim() === slug;
}

// What a suspension holds, in plain words (counts only).
export function describeImpact(openOrders: number, pendingNotifications: number): string[] {
  const lines = [
    "The online store stops taking orders and shows that the business is unavailable. Customers can still check the status of orders they already placed.",
    "Staff cannot sign in to this business until it is reactivated.",
  ];
  if (openOrders > 0) {
    lines.push(
      `${openOrders} open ${openOrders === 1 ? "order is" : "orders are"} not finished and cannot be progressed by staff while suspended. Nothing is cancelled or refunded.`,
    );
  }
  if (pendingNotifications > 0) {
    lines.push(
      `${pendingNotifications} pending ${pendingNotifications === 1 ? "notification is" : "notifications are"} held until reactivation; any that become out of date are not sent.`,
    );
  }
  lines.push("No data is deleted. Reactivating restores everything.");
  return lines;
}

export type LifecycleOutcome =
  | { kind: "done"; changed: boolean }
  | { kind: "reauth" }
  | { kind: "error"; message: string };

function code(body: unknown): string | null {
  return typeof body === "object" &&
    body !== null &&
    typeof (body as { code?: unknown }).code === "string"
    ? (body as { code: string }).code
    : null;
}

// Only the API's own fixed messages for a 400 are shown verbatim.
export function interpretLifecycleChange(status: number | null, body: unknown): LifecycleOutcome {
  if (status === 200) {
    const changed =
      typeof body === "object" && body !== null && (body as { changed?: unknown }).changed === true;
    return { kind: "done", changed };
  }
  switch (status) {
    case 400: {
      const message =
        typeof body === "object" &&
        body !== null &&
        typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message.slice(0, 200)
          : LIFECYCLE_MESSAGES.unavailable;
      return { kind: "error", message };
    }
    case 401:
      return code(body) === "REAUTHENTICATION_REQUIRED"
        ? { kind: "reauth" }
        : { kind: "error", message: LIFECYCLE_MESSAGES.sessionEnded };
    case 403:
      return { kind: "error", message: LIFECYCLE_MESSAGES.denied };
    case 404:
      return { kind: "error", message: LIFECYCLE_MESSAGES.notFound };
    case 409:
      switch (code(body)) {
        case "TENANT_PROTECTED":
          return { kind: "error", message: LIFECYCLE_MESSAGES.protected };
        case "OWNER_ALREADY_SIGNED_IN":
          return { kind: "error", message: LIFECYCLE_MESSAGES.ownerSignedIn };
        case "OWNER_EMAIL_IN_USE":
          return { kind: "error", message: LIFECYCLE_MESSAGES.emailInUse };
        default:
          return { kind: "error", message: LIFECYCLE_MESSAGES.unavailable };
      }
    case 429:
      return { kind: "error", message: LIFECYCLE_MESSAGES.tooMany };
    default:
      return { kind: "error", message: LIFECYCLE_MESSAGES.unavailable };
  }
}
