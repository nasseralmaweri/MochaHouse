import type { PlatformTenantProvisionResponse } from "@mocha-house/contracts";

// SC1d — the "Add a business" form's pure logic: the same rules the API
// enforces (so most mistakes are caught before a request), a slug suggested
// from the name, and how every API answer is shown. The API remains the
// authority; nothing here is trusted by it.

export type ProvisionField =
  | "name"
  | "slug"
  | "ownerEmail"
  | "ownerEmailConfirm"
  | "ownerDisplayName"
  | "planVersionId";

export interface ProvisionValues {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerEmailConfirm: string;
  ownerDisplayName: string;
  // SC2a — the published plan version the business starts on.
  planVersionId: string;
}

export type ProvisionFieldErrors = Partial<Record<ProvisionField, string>>;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PROVISION_MESSAGES = {
  sessionEnded: "Your session has ended. Sign in again to continue.",
  denied: "This account is not permitted to add businesses.",
  slugTaken: "Another business already uses this slug. Choose another.",
  keyReused:
    "This form was already used to add a different business. Reload the page to start again.",
  tooMany: "Too many attempts. Wait a few minutes, then try again.",
  unavailable:
    "The business could not be added right now. Nothing was created. Try again in a moment.",
  invalid: "Check the highlighted fields.",
} as const;

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

// "Blue Bean Café & Co." -> "blue-bean-cafe-co"
export function suggestSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

export function validateProvision(values: ProvisionValues): ProvisionFieldErrors {
  const errors: ProvisionFieldErrors = {};
  const name = values.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) {
    errors.name = "Enter the business name (2–120 characters).";
  }
  const slug = values.slug.trim().toLowerCase();
  if (slug.length < 3 || slug.length > 50 || !SLUG_PATTERN.test(slug)) {
    errors.slug =
      "Use 3–50 lowercase letters or numbers, in words joined by single hyphens.";
  }
  const email = normaliseEmail(values.ownerEmail);
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    errors.ownerEmail = "Enter the owner's email address.";
  } else if (normaliseEmail(values.ownerEmailConfirm) !== email) {
    errors.ownerEmailConfirm = "The two email addresses do not match.";
  }
  if (values.ownerDisplayName.trim().length > 120) {
    errors.ownerDisplayName = "Use 120 characters or fewer.";
  }
  if (!isOperationKey(values.planVersionId)) {
    errors.planVersionId = "Choose a plan for the business.";
  }
  return errors;
}

export type ProvisionOutcome =
  | { kind: "created"; result: PlatformTenantProvisionResponse }
  | { kind: "field"; field: ProvisionField; message: string }
  | { kind: "error"; message: string };

function bodyCode(body: unknown): string | null {
  return typeof body === "object" &&
    body !== null &&
    typeof (body as { code?: unknown }).code === "string"
    ? (body as { code: string }).code
    : null;
}

function isProvisionResponse(body: unknown): body is PlatformTenantProvisionResponse {
  if (typeof body !== "object" || body === null) return false;
  const value = body as Partial<PlatformTenantProvisionResponse>;
  return (
    typeof value.tenant?.id === "string" &&
    typeof value.tenant.name === "string" &&
    typeof value.owner?.email === "string" &&
    typeof value.replayed === "boolean"
  );
}

// How the API's answer is shown. Only the API's own fixed validation
// messages (400) are ever displayed verbatim; nothing else from a response
// body is.
export function interpretProvision(status: number | null, body: unknown): ProvisionOutcome {
  if ((status === 201 || status === 200) && isProvisionResponse(body)) {
    return { kind: "created", result: body };
  }
  switch (status) {
    case 400: {
      const message =
        typeof body === "object" &&
        body !== null &&
        typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : PROVISION_MESSAGES.invalid;
      return { kind: "error", message: message.slice(0, 200) };
    }
    case 401:
      return { kind: "error", message: PROVISION_MESSAGES.sessionEnded };
    case 403:
      return { kind: "error", message: PROVISION_MESSAGES.denied };
    case 409:
      return bodyCode(body) === "SLUG_TAKEN"
        ? { kind: "field", field: "slug", message: PROVISION_MESSAGES.slugTaken }
        : { kind: "error", message: PROVISION_MESSAGES.keyReused };
    case 429:
      return { kind: "error", message: PROVISION_MESSAGES.tooMany };
    default:
      return { kind: "error", message: PROVISION_MESSAGES.unavailable };
  }
}

const OPERATION_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOperationKey(value: unknown): value is string {
  return typeof value === "string" && OPERATION_KEY_PATTERN.test(value);
}
