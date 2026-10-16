import type {
  PlatformMfaSetupDisplayResponse,
  PlatformMfaSetupResponse,
  PlatformSessionResponse,
  PlatformSignInStepResponse,
} from "@mocha-house/contracts";
import { TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/rate-limit-message";

// SC1b — how the web tier reads each answer of the platform sign-in API.
// Pure, so every branch is unit-tested; the server actions only apply it.
// Messages are the web tier's own: a provider error never reaches the page.

export const PLATFORM_MESSAGES = {
  invalidCredentials: "Invalid email or password.",
  unreachable: "Could not reach the server. Check your connection and try again.",
  unavailable: "Platform sign-in is not available right now. Try again later.",
  tooMany: TOO_MANY_ATTEMPTS_MESSAGE,
  codeFormat: "Enter the 6-digit code from your authenticator app.",
} as const;

// Why the operator is back on the sign-in page. Never the reason an account
// was refused in any detail.
export type PlatformSignInNotice =
  | "expired"
  | "restart"
  | "not-permitted"
  | "account-setup"
  | "signed-out";

export const PLATFORM_NOTICES: Record<PlatformSignInNotice, string> = {
  expired: "Your session has ended. Sign in again to continue.",
  restart:
    "That code was not accepted, or the sign-in took too long. Sign in again.",
  "not-permitted":
    "This account is not permitted to access the CENTERIVO platform.",
  "account-setup":
    "This account is not ready to sign in yet. Contact a CENTERIVO administrator.",
  "signed-out": "You have signed out.",
};

export function noticeFrom(value: unknown): PlatformSignInNotice | null {
  return typeof value === "string" && value in PLATFORM_NOTICES
    ? (value as PlatformSignInNotice)
    : null;
}

export type SignInStep =
  | { kind: "mfa"; challenge: string }
  | { kind: "enrol"; challenge: string }
  | { kind: "notice"; notice: PlatformSignInNotice }
  | { kind: "error"; message: string };

const HANDLE = /^[A-Za-z0-9_-]{43}$/;

export function interpretSignIn(
  status: number,
  body: unknown,
): SignInStep {
  if (status === 200) {
    const step = body as Partial<PlatformSignInStepResponse> | null;
    if (step && typeof step.challenge === "string" && HANDLE.test(step.challenge)) {
      if (step.status === "mfa-required") {
        return { kind: "mfa", challenge: step.challenge };
      }
      if (step.status === "mfa-setup-required") {
        return { kind: "enrol", challenge: step.challenge };
      }
    }
    return { kind: "error", message: PLATFORM_MESSAGES.unavailable };
  }
  if (status === 400 || status === 401) {
    return { kind: "error", message: PLATFORM_MESSAGES.invalidCredentials };
  }
  if (status === 403) {
    return { kind: "notice", notice: "account-setup" };
  }
  if (status === 429) {
    return { kind: "error", message: PLATFORM_MESSAGES.tooMany };
  }
  return { kind: "error", message: PLATFORM_MESSAGES.unavailable };
}

export type EnrolmentStep =
  // The API issued an authenticator secret (kept server-side) and returned
  // the next handle.
  | { kind: "issued"; challenge: string }
  | { kind: "notice"; notice: PlatformSignInNotice }
  | { kind: "error"; message: string };

export function interpretMfaSetup(
  status: number,
  body: unknown,
): EnrolmentStep {
  if (status === 200) {
    const setup = body as Partial<PlatformMfaSetupResponse> | null;
    if (setup && typeof setup.challenge === "string" && HANDLE.test(setup.challenge)) {
      return { kind: "issued", challenge: setup.challenge };
    }
    return { kind: "error", message: PLATFORM_MESSAGES.unavailable };
  }
  if (status === 401) return { kind: "notice", notice: "restart" };
  if (status === 429) return { kind: "error", message: PLATFORM_MESSAGES.tooMany };
  return { kind: "error", message: PLATFORM_MESSAGES.unavailable };
}

// The setup page's server-side read of the issued secret. Only a
// well-formed base32 secret and otpauth:// URI are ever rendered.
export function interpretMfaDisplay(
  status: number,
  body: unknown,
): PlatformMfaSetupDisplayResponse | null {
  if (status !== 200) return null;
  const display = body as Partial<PlatformMfaSetupDisplayResponse> | null;
  if (
    display &&
    typeof display.secret === "string" &&
    /^[A-Z2-7]+=*$/.test(display.secret) &&
    typeof display.otpauthUri === "string" &&
    display.otpauthUri.startsWith("otpauth://totp/")
  ) {
    return { secret: display.secret, otpauthUri: display.otpauthUri };
  }
  return null;
}

export type CodeStep =
  | { kind: "session"; idToken: string; expiresInSeconds: number }
  // The challenge is still usable (the code was malformed, or rate limited):
  // stay on the page.
  | { kind: "error"; message: string }
  // The challenge is spent (wrong code, expired, replayed) or the account
  // is refused: back to the sign-in page with a notice.
  | { kind: "notice"; notice: PlatformSignInNotice };

export function interpretCode(status: number, body: unknown): CodeStep {
  if (status === 200) {
    const session = body as Partial<PlatformSessionResponse> | null;
    if (
      session &&
      typeof session.idToken === "string" &&
      session.idToken.length > 0 &&
      typeof session.expiresInSeconds === "number"
    ) {
      return {
        kind: "session",
        idToken: session.idToken,
        expiresInSeconds: session.expiresInSeconds,
      };
    }
    return { kind: "error", message: PLATFORM_MESSAGES.unavailable };
  }
  if (status === 400) return { kind: "error", message: PLATFORM_MESSAGES.codeFormat };
  if (status === 401) return { kind: "notice", notice: "restart" };
  if (status === 403) return { kind: "notice", notice: "not-permitted" };
  if (status === 429) return { kind: "error", message: PLATFORM_MESSAGES.tooMany };
  return { kind: "error", message: PLATFORM_MESSAGES.unavailable };
}

export function isSixDigitCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

// Normalises what the operator typed ("123 456", "123-456") to six digits.
export function normaliseCode(raw: unknown): string {
  return String(raw ?? "").replace(/[\s-]/g, "");
}

// The authenticator secret shown in groups of four for manual entry.
export function groupSecret(secret: string): string {
  return secret.replace(/=+$/, "").replace(/(.{4})(?=.)/g, "$1 ");
}

export type PlatformSessionState =
  | "signed-in"
  | "signed-out"
  | "expired"
  | "forbidden"
  | "unavailable";

// GET /api/v1/platform/me -> what the portal does.
export function sessionStateFromStatus(
  status: number | null,
): Exclude<PlatformSessionState, "signed-out"> {
  if (status === 200) return "signed-in";
  if (status === 401) return "expired";
  if (status === 403) return "forbidden";
  return "unavailable";
}
