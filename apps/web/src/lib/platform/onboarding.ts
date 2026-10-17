import {
  PLATFORM_ONBOARDING_FILTERS,
  PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT,
  PLATFORM_REGISTRATION_FILTERS,
  type GettingStartedStepKey,
  type OwnerRegistrationStatusValue,
  type PlatformOnboardingFilter,
  type PlatformRegistrationControlView,
  type PlatformRegistrationFilter,
  type PlatformRegistrationIssue,
} from "@mocha-house/contracts";

// SC4e — wording and query handling for the Platform Console's onboarding
// oversight. The API decides everything (permissions, masking, progress);
// this only presents it and builds the query strings it accepts.

export const ONBOARDING_VIEW_PERMISSION = "onboarding.view";
export const ONBOARDING_MANAGE_PERMISSION = "onboarding.manage";

export const REGISTRATION_STATUS_LABEL: Record<OwnerRegistrationStatusValue, string> = {
  PENDING_VERIFICATION: "Waiting for email code",
  PASSWORD_SETUP: "Setting password",
  VERIFIED: "Verified",
};

export const REGISTRATION_ISSUE_LABEL: Record<PlatformRegistrationIssue, string> = {
  EXPIRED: "Code expired before verification",
  STALLED: "Stopped during verification",
  NO_BUSINESS: "Verified, no business yet",
};

export const REGISTRATION_FILTER_LABEL: Record<PlatformRegistrationFilter, string> = {
  all: "All",
  pending: "Waiting for code",
  "password-setup": "Setting password",
  verified: "Verified",
  "with-business": "Business created",
  expired: "Expired",
  stalled: "Stopped in verification",
  "no-business": "No business",
};

export const ONBOARDING_FILTER_LABEL: Record<PlatformOnboardingFilter, string> = {
  all: "All",
  "awaiting-payment": "Awaiting payment",
  "missing-location": "No location",
  "missing-hours": "No hours",
  "missing-menu": "No menu",
  "ordering-off": "Ordering off",
  stuck: "Stuck",
};

// Short column titles for the business's getting-started steps.
export const STEP_COLUMN_LABEL: Record<GettingStartedStepKey, string> = {
  business: "Business",
  billing: "Payment",
  location: "Location",
  profile: "Address",
  hours: "Hours",
  menu: "Menu",
  ordering: "Ordering",
};

type Raw = Record<string, string | string[] | undefined>;

function first(raw: Raw, name: string): string | undefined {
  const value = raw[name];
  return Array.isArray(value) ? value[0] : value;
}

function page(raw: Raw): number {
  const value = Number(first(raw, "page"));
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : 1;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RegistrationFilters {
  filter: PlatformRegistrationFilter;
  createdFrom: string;
  createdTo: string;
  page: number;
}

// Search params -> the filters the API accepts (anything unknown is dropped,
// so a hand-edited URL never turns into a 400 page).
export function registrationFilters(raw: Raw): RegistrationFilters {
  const filter = first(raw, "filter");
  const from = first(raw, "createdFrom") ?? "";
  const to = first(raw, "createdTo") ?? "";
  return {
    filter: (PLATFORM_REGISTRATION_FILTERS as readonly string[]).includes(filter ?? "")
      ? (filter as PlatformRegistrationFilter)
      : "all",
    createdFrom: DATE.test(from) ? from : "",
    createdTo: DATE.test(to) ? to : "",
    page: page(raw),
  };
}

export function registrationQuery(filters: RegistrationFilters, pageSize = 20): string {
  const params = new URLSearchParams({ filter: filters.filter, page: String(filters.page), pageSize: String(pageSize) });
  if (filters.createdFrom) params.set("createdFrom", filters.createdFrom);
  if (filters.createdTo) params.set("createdTo", filters.createdTo);
  return params.toString();
}

export interface OnboardingFilters {
  filter: PlatformOnboardingFilter;
  stuckDays: number;
  page: number;
}

export function onboardingFilters(raw: Raw): OnboardingFilters {
  const filter = first(raw, "filter");
  const days = Number(first(raw, "stuckDays"));
  return {
    filter: (PLATFORM_ONBOARDING_FILTERS as readonly string[]).includes(filter ?? "")
      ? (filter as PlatformOnboardingFilter)
      : "all",
    stuckDays:
      Number.isInteger(days) && days >= 1 && days <= 90
        ? days
        : PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT,
    page: page(raw),
  };
}

export function onboardingQuery(filters: OnboardingFilters, pageSize = 20): string {
  return new URLSearchParams({
    filter: filters.filter,
    stuckDays: String(filters.stuckDays),
    page: String(filters.page),
    pageSize: String(pageSize),
  }).toString();
}

// The one-line availability statement at the top of the onboarding page.
export function availabilitySummary(view: PlatformRegistrationControlView): {
  tone: "positive" | "warning" | "neutral";
  title: string;
  detail: string;
} {
  if (view.flag !== "ON") {
    return {
      tone: "neutral",
      title: "Registration is off for this deployment",
      detail:
        view.flag === "MISCONFIGURED"
          ? "The deployment's registration switch is on but its settings are incomplete, so registration stays off. Operators cannot turn it on from here."
          : "The deployment's registration switch is off. Operators cannot turn it on from here." +
            (view.paused ? " New registrations would also stay paused." : ""),
    };
  }
  if (view.paused) {
    return {
      tone: "warning",
      title: "New registrations are paused",
      detail:
        "Nobody can start a new registration or get a new code. People who already have a code can still finish, and existing businesses are unaffected.",
    };
  }
  if (view.quota.limit !== null && view.quota.usedInWindow >= view.quota.limit) {
    return {
      tone: "warning",
      title: "Limit reached: new registrations are blocked for now",
      detail: view.quota.nextFreeAt
        ? `A new place opens at ${when(view.quota.nextFreeAt)}, when a registration from 24 hours earlier stops counting.`
        : "A new place opens when a registration from 24 hours earlier stops counting.",
    };
  }
  return {
    tone: "positive",
    title: "Accepting new registrations",
    detail: "The deployment's registration switch is on and registration is not paused.",
  };
}

const when = (iso: string) =>
  `${new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;

export function formatPlatformTime(iso: string | null): string {
  return iso ? when(iso) : "—";
}

// The quota line, with the counting period stated plainly.
export function quotaSummary(quota: PlatformRegistrationControlView["quota"]): string {
  if (quota.limit === null) {
    return `${quota.usedInWindow} new registrations in the last 24 hours. The configured daily limit is invalid, so registration stays off.`;
  }
  const base = `${quota.usedInWindow} of ${quota.limit} new registrations used in the last 24 hours (a rolling window, not a calendar day).`;
  return quota.nextFreeAt
    ? `${base} The limit is reached: the next place frees up at ${when(quota.nextFreeAt)}.`
    : base;
}

export type ControlOutcome =
  | { kind: "ok"; view: PlatformRegistrationControlView }
  | { kind: "reauth" }
  | { kind: "error"; message: string };

export const CONTROL_MESSAGES = {
  reauth:
    "For your security, sign in again to make this change. Changes need a sign-in within the last 15 minutes.",
  sessionEnded: "Your session has ended. Sign in again to continue.",
  denied:
    "Your operator account doesn't have permission to pause or resume registrations. Ask a CENTERIVO administrator to grant onboarding.manage.",
  unchanged: "Registration is already in that state. Nothing was changed.",
  tooMany: "Too many changes just now. Wait a little and try again.",
  unavailable: "The change could not be made right now. Try again.",
  reason: "Give a reason of 10 to 500 characters.",
};

function bodyField(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

export function interpretControlChange(status: number | null, body: unknown): ControlOutcome {
  if (status === 200 && body && typeof body === "object") {
    return { kind: "ok", view: body as PlatformRegistrationControlView };
  }
  switch (status) {
    case 400: {
      const message = bodyField(body, "message");
      return {
        kind: "error",
        message: typeof message === "string" ? message.slice(0, 200) : CONTROL_MESSAGES.reason,
      };
    }
    case 401:
      return bodyField(body, "code") === "REAUTHENTICATION_REQUIRED"
        ? { kind: "reauth" }
        : { kind: "error", message: CONTROL_MESSAGES.sessionEnded };
    case 403:
      return { kind: "error", message: CONTROL_MESSAGES.denied };
    case 409:
      return { kind: "error", message: CONTROL_MESSAGES.unchanged };
    case 429:
      return { kind: "error", message: CONTROL_MESSAGES.tooMany };
    default:
      return { kind: "error", message: CONTROL_MESSAGES.unavailable };
  }
}

export function validReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 10 && trimmed.length <= 500;
}
