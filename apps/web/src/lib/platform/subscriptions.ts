import {
  OPTIONAL_MODULE_KEYS,
  SUBSCRIPTION_MODULES,
  type OptionalModuleKey,
  type PlatformPlan,
  type PlatformPlanVersion,
  type SubscriptionModuleKey,
} from "@mocha-house/contracts";

// SC2a — the Plans and Subscription screens' pure logic: module labels,
// version labels, which versions can be offered, plan form checks, and how
// every API answer is shown (never a server detail).

const LABELS = new Map(SUBSCRIPTION_MODULES.map((m) => [m.key, m.label]));

export function moduleLabel(key: SubscriptionModuleKey): string {
  return LABELS.get(key) ?? key;
}

export function moduleDescription(key: SubscriptionModuleKey): string {
  return SUBSCRIPTION_MODULES.find((m) => m.key === key)?.description ?? "";
}

export const VERSION_STATUS_LABELS: Record<PlatformPlanVersion["status"], string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  RETIRED: "Retired",
};

export function versionLabel(plan: Pick<PlatformPlan, "name">, version: Pick<PlatformPlanVersion, "version">): string {
  return `${plan.name} v${version.version}`;
}

// The versions that can be assigned: PUBLISHED only, newest first per plan.
export function assignableVersions(
  plans: readonly PlatformPlan[],
): Array<{ id: string; label: string; moduleKeys: OptionalModuleKey[] }> {
  return plans.flatMap((plan) =>
    plan.versions
      .filter((version) => version.status === "PUBLISHED")
      .map((version) => ({
        id: version.id,
        label: versionLabel(plan, version),
        moduleKeys: version.moduleKeys,
      })),
  );
}

// Optional modules not already available (for an add-on choice).
export function addOnCandidates(modules: readonly SubscriptionModuleKey[]): OptionalModuleKey[] {
  return OPTIONAL_MODULE_KEYS.filter((key) => !modules.includes(key));
}

const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validatePlanForm(key: string, name: string): { key?: string; name?: string } {
  const errors: { key?: string; name?: string } = {};
  const k = key.trim().toLowerCase();
  if (k.length < 2 || k.length > 50 || !KEY_PATTERN.test(k)) {
    errors.key = "Use 2–50 lowercase letters or numbers, in words joined by single hyphens.";
  }
  const n = name.trim();
  if (n.length < 2 || n.length > 80) errors.name = "Enter a name of 2–80 characters.";
  return errors;
}

export const SUBSCRIPTION_MESSAGES = {
  reauth:
    "For your security, sign in again to make this change. Changes need a sign-in within the last 15 minutes.",
  sessionEnded: "Your session has ended. Sign in again to continue.",
  denied: "This account is not permitted to change plans or subscriptions.",
  notFound: "That plan, version or business could not be found.",
  keyTaken: "Another plan already uses that key.",
  draftExists: "This plan already has a draft version. Edit or publish it first.",
  notDraft: "Only a draft version can be edited or published.",
  notPublished: "Only a published plan version can be assigned or retired.",
  noSubscription: "This business has no subscription yet. Assign a plan first.",
  addonInPlan: "That module is already in the business's plan.",
  // SC3a — a billed business changes plan only through billing.
  billed: "This business is billed: its plan and add-ons change through billing. Nothing was changed.",
  // SC3b — starting billing and reconciliation.
  alreadyBilled: "This business is already billed. Nothing was changed.",
  founding: "Founding businesses are complimentary and are never billed.",
  priceNotForPlan: "That price isn't one of this business's plan's prices.",
  priceNotActive: "That price is no longer offered. Choose a current price.",
  noOwner: "This business has no owner to bill yet.",
  caseResolved: "This case was already resolved.",
  billingUnavailable: "Billing isn't available right now. Nothing was changed. Try again in a moment.",
  tooMany: "Too many changes. Wait a few minutes, then try again.",
  unavailable: "The change could not be made right now. Nothing was changed. Try again in a moment.",
} as const;

const CONFLICTS: Record<string, string> = {
  PLAN_KEY_TAKEN: SUBSCRIPTION_MESSAGES.keyTaken,
  PLAN_DRAFT_EXISTS: SUBSCRIPTION_MESSAGES.draftExists,
  PLAN_VERSION_NOT_DRAFT: SUBSCRIPTION_MESSAGES.notDraft,
  PLAN_VERSION_NOT_PUBLISHED: SUBSCRIPTION_MESSAGES.notPublished,
  NO_SUBSCRIPTION: SUBSCRIPTION_MESSAGES.noSubscription,
  ADDON_IN_PLAN: SUBSCRIPTION_MESSAGES.addonInPlan,
  SUBSCRIPTION_BILLED: SUBSCRIPTION_MESSAGES.billed,
  ALREADY_BILLED: SUBSCRIPTION_MESSAGES.alreadyBilled,
  FOUNDING_COMPLIMENTARY: SUBSCRIPTION_MESSAGES.founding,
  PRICE_NOT_FOR_PLAN: SUBSCRIPTION_MESSAGES.priceNotForPlan,
  PRICE_NOT_ACTIVE: SUBSCRIPTION_MESSAGES.priceNotActive,
  NO_OWNER: SUBSCRIPTION_MESSAGES.noOwner,
  CASE_ALREADY_RESOLVED: SUBSCRIPTION_MESSAGES.caseResolved,
  // SC3c-3 — grace extensions and the billing contact.
  BILLING_NOT_EXTENDABLE:
    "Only a business with an unpaid invoice can be given more time. Reload to see its current billing.",
  BILLING_EXTENSION_LIMIT:
    "That's more than allowed: at most 14 days at a time and 60 days in total until the business pays.",
  BILLING_NOT_RECOVERABLE:
    "The payment provider has ended this subscription, so it can't be given more time. Nothing was changed.",
  BILLING_CONTACT_NOT_ELIGIBLE:
    "Choose an active staff member of this business who can manage billing.",
};

export type ChangeOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "reauth" }
  | { kind: "error"; message: string };

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

// Only the API's own fixed 400 messages are shown verbatim.
export function interpretChange<T>(status: number | null, body: unknown): ChangeOutcome<T> {
  if (status === 200 || status === 201) {
    return body && typeof body === "object"
      ? { kind: "ok", data: body as T }
      : { kind: "error", message: SUBSCRIPTION_MESSAGES.unavailable };
  }
  switch (status) {
    case 400: {
      const message = field(body, "message");
      return {
        kind: "error",
        message: typeof message === "string" ? message.slice(0, 200) : SUBSCRIPTION_MESSAGES.unavailable,
      };
    }
    case 401:
      return field(body, "code") === "REAUTHENTICATION_REQUIRED"
        ? { kind: "reauth" }
        : { kind: "error", message: SUBSCRIPTION_MESSAGES.sessionEnded };
    case 403:
      return { kind: "error", message: SUBSCRIPTION_MESSAGES.denied };
    case 404:
      return { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound };
    case 409: {
      const code = field(body, "code");
      return {
        kind: "error",
        message: (typeof code === "string" && CONFLICTS[code]) || SUBSCRIPTION_MESSAGES.unavailable,
      };
    }
    case 429:
      return { kind: "error", message: SUBSCRIPTION_MESSAGES.tooMany };
    default:
      return { kind: "error", message: SUBSCRIPTION_MESSAGES.unavailable };
  }
}
