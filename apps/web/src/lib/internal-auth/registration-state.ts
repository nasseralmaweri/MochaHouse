import { TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/rate-limit-message";

// SC4a — the owner registration form's state, and how each API answer moves
// it. Pure (no fetch, no cookies) so it can be unit tested. The email lives
// only in this state — never in the URL.

export type RegistrationState =
  | { step: "email"; email: string; error: string | null }
  | {
      step: "code";
      email: string;
      error: string | null;
      notice: string | null;
    }
  | { step: "done" };

export const INITIAL_REGISTRATION_STATE: RegistrationState = {
  step: "email",
  email: "",
  error: null,
};

export const CODE_SENT_NOTICE =
  "If this email can be used to register, we sent a code to it. It can take a minute to arrive — check your spam folder too.";
export const UNAVAILABLE_MESSAGE =
  "Registration isn't available right now. Please try again later.";
const UNREACHABLE_MESSAGE =
  "Could not reach the server. Check your connection and try again.";
const LEGAL_CHANGED_MESSAGE =
  "The Terms of Service or Privacy Policy were updated. Reload the page to review them, then try again.";

export interface ApiAnswer {
  status: number;
  // The API's own (user-safe) message for a 400, when it sent one.
  message: string | null;
}

function failureMessage(answer: ApiAnswer | null): string {
  if (answer === null) return UNREACHABLE_MESSAGE;
  if (answer.status === 429) return TOO_MANY_ATTEMPTS_MESSAGE;
  if (answer.status === 409) return LEGAL_CHANGED_MESSAGE;
  if (answer.status === 400 && answer.message) return answer.message;
  return UNAVAILABLE_MESSAGE;
}

// After asking for a code (first time or again).
export function afterStart(
  email: string,
  answer: ApiAnswer | null,
  from: "email" | "code",
): RegistrationState {
  if (answer?.status === 202) {
    return { step: "code", email, error: null, notice: CODE_SENT_NOTICE };
  }
  const error = failureMessage(answer);
  return from === "code"
    ? { step: "code", email, error, notice: null }
    : { step: "email", email, error };
}

// After submitting the code, name and password.
export function afterComplete(
  email: string,
  answer: ApiAnswer | null,
): RegistrationState {
  if (answer?.status === 200) return { step: "done" };
  return { step: "code", email, error: failureMessage(answer), notice: null };
}

export function readApiMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.length <= 300 ? message : null;
}
