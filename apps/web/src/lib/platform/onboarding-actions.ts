"use server";

import { revalidatePath } from "next/cache";
import {
  getPlatformSessionToken,
  platformApiUrl,
} from "@/lib/platform-auth/session";
import {
  CONTROL_MESSAGES,
  interpretControlChange,
  validReason,
  type ControlOutcome,
} from "./onboarding";

// SC4e — pausing / resuming NEW owner registrations from the console. Posts
// to the API's platform boundary from the server with the operator's
// HttpOnly session (the token never reaches the browser). The API decides:
// onboarding.manage, a recent sign-in, a reason, and never past the
// deployment's own switch.

export interface ControlFormState {
  outcome: ControlOutcome | null;
  fieldError: string | null;
}

export async function changeRegistrationControlAction(
  _previous: ControlFormState,
  form: FormData,
): Promise<ControlFormState> {
  const paused = form.get("paused");
  const reasonValue = form.get("reason");
  const reason = typeof reasonValue === "string" ? reasonValue : "";
  if (paused !== "true" && paused !== "false") {
    return { outcome: { kind: "error", message: CONTROL_MESSAGES.unavailable }, fieldError: null };
  }
  if (!validReason(reason)) {
    return { outcome: null, fieldError: CONTROL_MESSAGES.reason };
  }
  const token = await getPlatformSessionToken();
  if (!token) {
    return { outcome: { kind: "error", message: CONTROL_MESSAGES.sessionEnded }, fieldError: null };
  }
  let outcome: ControlOutcome;
  try {
    const response = await fetch(`${platformApiUrl()}/platform/onboarding/registration-control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: paused === "true", reason: reason.trim() }),
      cache: "no-store",
    });
    outcome = interpretControlChange(response.status, await response.json().catch(() => null));
  } catch {
    outcome = interpretControlChange(null, null);
  }
  if (outcome.kind === "ok") revalidatePath("/platform/onboarding");
  return { outcome, fieldError: null };
}
