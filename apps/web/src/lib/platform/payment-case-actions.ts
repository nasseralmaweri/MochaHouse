"use server";

import { revalidatePath } from "next/cache";
import {
  getPlatformSessionToken,
  platformApiUrl,
} from "@/lib/platform-auth/session";
import {
  PAYMENT_CASE_MESSAGES,
  interpretPaymentCaseChange,
  validCaseId,
  validNote,
  validRecoveryReason,
  type PaymentCaseOutcome,
} from "./payment-cases";

// ESP-03 PR 5 — a safe recovery request and internal notes on a restaurant
// payment case. Posts to the API's platform boundary from the server with
// the operator's HttpOnly session (the token never reaches the browser). The
// API decides: payments.reconciliation.manage, a recent sign-in, and whether
// the payment can be recovered at all. A recovery never charges.

export interface PaymentCaseFormState {
  outcome: PaymentCaseOutcome | null;
  fieldError: string | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function paymentCaseAction(
  _previous: PaymentCaseFormState,
  form: FormData,
): Promise<PaymentCaseFormState> {
  const caseId = form.get("caseId");
  const intent = text(form, "intent");
  if (!validCaseId(caseId) || (intent !== "recover" && intent !== "note")) {
    return { outcome: { kind: "error", message: PAYMENT_CASE_MESSAGES.unavailable }, fieldError: null };
  }
  let path: string;
  let body: Record<string, string>;
  if (intent === "recover") {
    const reason = text(form, "reason");
    if (!validRecoveryReason(reason)) return { outcome: null, fieldError: PAYMENT_CASE_MESSAGES.reason };
    path = "recover";
    body = { reason: reason.trim() };
  } else {
    const note = text(form, "body");
    if (!validNote(note)) return { outcome: null, fieldError: PAYMENT_CASE_MESSAGES.note };
    path = "notes";
    body = { body: note.trim() };
  }
  const token = await getPlatformSessionToken();
  if (!token) {
    return { outcome: { kind: "error", message: PAYMENT_CASE_MESSAGES.sessionEnded }, fieldError: null };
  }
  let outcome: PaymentCaseOutcome;
  try {
    const response = await fetch(
      `${platformApiUrl()}/platform/payment-cases/${encodeURIComponent(caseId)}/${path}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
    outcome = interpretPaymentCaseChange(intent, response.status, await response.json().catch(() => null));
  } catch {
    outcome = interpretPaymentCaseChange(intent, null, null);
  }
  if (outcome.kind === "ok") revalidatePath(`/platform/payments/${caseId}`);
  return { outcome, fieldError: null };
}
