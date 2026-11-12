import type {
  AdminAccessAssignmentOptions,
  AdminCreateInternalUserRequest,
  AdminStaffInvitationOutcome,
  AdminStaffInvitationResponse,
  AdminStaffLoginSetup,
} from "@mocha-house/contracts";
// Mutating calls to this app's own /api proxy carry the request marker header
// (rejectUntrustedOrigin); markedFetch adds it, like api-client.
import { markedFetch as fetch } from "@/lib/security/marked-fetch";

// V1 launch fix 2 — "Add employee" in Administration → Users. The API is the
// authority: it takes the business from the administrator's sign-in, checks
// both staff-management permissions and the privilege ceiling, validates the
// access level and locations, and asks the identity provider to invite the
// login. This module only shapes the form, the request and the messages.

const PROXY = "/api/internal/admin";

// --- the form -----------------------------------------------------------------

export interface EmployeeDraft {
  displayName: string;
  email: string;
  accessLevelId: string;
  locationIds: string[];
}

export const EMPTY_EMPLOYEE: EmployeeDraft = {
  displayName: "",
  email: "",
  accessLevelId: "",
  locationIds: [],
};

export interface EmployeeErrors {
  displayName?: string;
  email?: string;
  accessLevel?: string;
  locations?: string;
}

const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Checked again by the API; this only gives readable errors early.
export function buildEmployeeRequest(
  draft: EmployeeDraft,
  options: AdminAccessAssignmentOptions,
):
  | { ok: true; request: AdminCreateInternalUserRequest }
  | { ok: false; errors: EmployeeErrors } {
  const errors: EmployeeErrors = {};
  const displayName = draft.displayName.trim();
  if (displayName.length === 0) errors.displayName = "Enter the employee's name.";
  else if (displayName.length > 120) errors.displayName = "Keep the name to 120 characters.";

  const email = draft.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  const level = options.accessLevels.find((l) => l.id === draft.accessLevelId);
  if (!level) errors.accessLevel = "Choose an access level.";

  const activeIds = new Set(options.locations.map((l) => l.id));
  const locationIds = [...new Set(draft.locationIds)].filter((id) =>
    activeIds.has(id),
  );
  if (level?.assignmentShape === "location-only" && locationIds.length === 0) {
    errors.locations = "Choose at least one location.";
  }

  if (errors.displayName || errors.email || errors.accessLevel || errors.locations) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    request: {
      displayName,
      email,
      roleId: level!.id,
      scope:
        level!.assignmentShape === "corporate-only"
          ? { kind: "corporate" }
          : { kind: "locations", locationIds },
    },
  };
}

// --- the calls -------------------------------------------------------------------

export type StaffInvitationResult =
  | { outcome: "success"; data: AdminStaffInvitationResponse }
  | { outcome: "invalid"; message: string }
  | { outcome: "conflict"; message: string }
  | { outcome: "forbidden"; message: string }
  | { outcome: "not-found" }
  | { outcome: "error"; message: string };

async function messageOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : null;
  } catch {
    return null;
  }
}

function redirectToInternalSignIn(): void {
  if (typeof window !== "undefined") {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/internal/sign-in";
  }
}

async function post(path: string, body: unknown): Promise<StaffInvitationResult> {
  let response: Response;
  try {
    response = await fetch(`${PROXY}/internal-users${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      outcome: "error",
      message: "Could not reach the server. Check your connection and try again.",
    };
  }
  if (response.status === 401) {
    redirectToInternalSignIn();
    return { outcome: "error", message: "Your session has expired. Sign in again." };
  }
  if (response.status === 403) {
    return {
      outcome: "forbidden",
      message:
        (await messageOf(response)) ??
        "You don't have permission to add employees with this access.",
    };
  }
  if (response.status === 404) {
    // An access level that is not this business's (never disclosed further).
    return { outcome: "not-found" };
  }
  if (response.status === 400) {
    return {
      outcome: "invalid",
      message: (await messageOf(response)) ?? "Please check the details.",
    };
  }
  if (response.status === 409) {
    return {
      outcome: "conflict",
      message:
        (await messageOf(response)) ??
        "Someone with this email is already part of this business.",
    };
  }
  if (response.status === 429) {
    return {
      outcome: "error",
      message: "Too many invitations in a short time. Wait a few minutes, then try again.",
    };
  }
  if (!response.ok) {
    return {
      outcome: "error",
      message: "Something went wrong. Check the Users list before trying again.",
    };
  }
  try {
    const data = (await response.json()) as AdminStaffInvitationResponse;
    if (!data || typeof data !== "object" || !data.user || !data.invitation) {
      throw new Error("unexpected reply");
    }
    return { outcome: "success", data };
  } catch {
    return {
      outcome: "error",
      message: "The reply couldn't be read. Check the Users list before trying again.",
    };
  }
}

export function addEmployeeFromBrowser(
  request: AdminCreateInternalUserRequest,
): Promise<StaffInvitationResult> {
  return post("", request);
}

export function sendLoginInvitationFromBrowser(
  internalUserId: string,
): Promise<StaffInvitationResult> {
  return post(`/${encodeURIComponent(internalUserId)}/login-invitation`, {});
}

// --- plain language ---------------------------------------------------------------

// What happened with the sign-in invitation — never "sent" unless the
// identity provider confirmed it.
export function invitationMessage(
  outcome: AdminStaffInvitationOutcome,
  email: string,
): string {
  switch (outcome) {
    case "INVITATION_SENT":
      return `Invitation sent to ${email}. They'll get an email with a temporary password, choose their own when they first sign in, and their access starts then.`;
    case "EXISTING_LOGIN":
      return `${email} already has a CENTERIVO sign-in. They sign in with their current password, and their access here starts then.`;
    case "PENDING":
      return `Login setup is pending: the sign-in service couldn't be reached, so no invitation was sent. Send it again from their page in a few minutes.`;
  }
}

export function loginSetupLabel(setup: AdminStaffLoginSetup | null | undefined): string | null {
  switch (setup) {
    case "INVITATION_SENT":
      return "Invitation sent — waiting for their first sign-in";
    case "PENDING":
      return "Login setup pending — invitation not sent yet";
    default:
      return null;
  }
}
