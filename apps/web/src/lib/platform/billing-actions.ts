"use server";

import { revalidatePath } from "next/cache";
import {
  PLATFORM_PERMISSIONS,
  type PlatformAdjustmentPreview,
  type PlatformAdjustmentView,
  type PlatformOperatorDirectoryResponse,
  type PlatformPermission,
  PLATFORM_CASE_OUTCOMES,
  type PlatformCaseDetailResponse,
  type PlatformCaseOutcome,
  type PlatformCaseRecheckResponse,
  type PlatformComplimentaryView,
  type PlatformReconciliationRunResponse,
  type PlatformTenantBillingResponse,
} from "@mocha-house/contracts";
import { parseEndDate, validReason } from "./complimentary";
import { parseAmount, validNote } from "./adjustments";
import { getPlatformSessionToken, platformApiUrl } from "@/lib/platform-auth/session";
import { isTenantId } from "./tenant-registry";
import { SUBSCRIPTION_MESSAGES, interpretChange, type ChangeOutcome } from "./subscriptions";

// SC3b — server actions for starting a business's billing and for the
// review-only reconciliation. They call the API's platform boundary from the
// server with the operator's HttpOnly session (the token never reaches the
// browser). No money moves here.

export interface BillingActionState<T> {
  outcome: ChangeOutcome<T> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function call<T>(
  path: string,
  body?: object,
  method: "POST" | "PUT" = "POST",
): Promise<ChangeOutcome<T>> {
  const token = await getPlatformSessionToken();
  if (!token) return { kind: "error", message: SUBSCRIPTION_MESSAGES.sessionEnded };
  try {
    const response = await fetch(`${platformApiUrl()}/platform${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const outcome = interpretChange<T>(
      response.status,
      await response.json().catch(() => null),
    );
    if (response.status === 503) {
      return { kind: "error", message: SUBSCRIPTION_MESSAGES.billingUnavailable };
    }
    return outcome;
  } catch {
    return interpretChange<T>(null, null);
  }
}

export async function startBillingAction(
  _previous: BillingActionState<PlatformTenantBillingResponse>,
  form: FormData,
): Promise<BillingActionState<PlatformTenantBillingResponse>> {
  const tenantId = form.get("tenantId");
  const planPriceId = form.get("planPriceId");
  if (typeof tenantId !== "string" || !isTenantId(tenantId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (typeof planPriceId !== "string" || !UUID.test(planPriceId)) {
    return { outcome: { kind: "error", message: "Choose a price." } };
  }
  const outcome = await call<PlatformTenantBillingResponse>(
    `/tenants/${encodeURIComponent(tenantId)}/billing/start`,
    { planPriceId },
  );
  if (outcome.kind === "ok") revalidatePath(`/platform/tenants/${tenantId}`);
  return { outcome };
}

// SC3c-3 — designate the business's billing contact (one of its staff).
export async function assignBillingContactAction(
  _previous: BillingActionState<PlatformTenantBillingResponse>,
  form: FormData,
): Promise<BillingActionState<PlatformTenantBillingResponse>> {
  const tenantId = form.get("tenantId");
  const internalUserId = form.get("internalUserId");
  if (typeof tenantId !== "string" || !isTenantId(tenantId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (typeof internalUserId !== "string" || !UUID.test(internalUserId)) {
    return { outcome: { kind: "error", message: "Choose a staff member." } };
  }
  const outcome = await call<PlatformTenantBillingResponse>(
    `/tenants/${encodeURIComponent(tenantId)}/billing/contact`,
    { internalUserId },
    "PUT",
  );
  if (outcome.kind === "ok") revalidatePath(`/platform/tenants/${tenantId}`);
  return { outcome };
}

// SC3c-3 — more time for an unpaid business (audited; the debt stays).
export async function extendGraceAction(
  _previous: BillingActionState<PlatformTenantBillingResponse>,
  form: FormData,
): Promise<BillingActionState<PlatformTenantBillingResponse>> {
  const tenantId = form.get("tenantId");
  const days = Number(form.get("days"));
  const reason = form.get("reason");
  if (typeof tenantId !== "string" || !isTenantId(tenantId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (!Number.isInteger(days) || days < 1 || days > 14) {
    return { outcome: { kind: "error", message: "Choose from 1 to 14 days." } };
  }
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.trim().length > 500) {
    return {
      outcome: { kind: "error", message: "Give a reason of 10 to 500 characters." },
    };
  }
  const outcome = await call<PlatformTenantBillingResponse>(
    `/tenants/${encodeURIComponent(tenantId)}/billing/grace-extension`,
    { days, reason: reason.trim() },
  );
  if (outcome.kind === "ok") revalidatePath(`/platform/tenants/${tenantId}`);
  return { outcome };
}

// Used with useActionState; the previous state is not needed.
export async function runReconciliationAction(): Promise<
  BillingActionState<PlatformReconciliationRunResponse>
> {
  const outcome = await call<PlatformReconciliationRunResponse>("/billing/reconcile");
  if (outcome.kind === "ok") revalidatePath("/platform/billing");
  return { outcome };
}

const REASON_MESSAGE = "Give a reason of 10 to 500 characters (one line).";

// SC3e-2 — close a case with an outcome and a note (billing.cases.manage).
export async function closeCaseAction(
  _previous: BillingActionState<{ resolved: true }>,
  form: FormData,
): Promise<BillingActionState<{ resolved: true }>> {
  const caseId = form.get("caseId");
  const outcome = form.get("outcome");
  const note = validReason(form.get("note"));
  if (typeof caseId !== "string" || !UUID.test(caseId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (!PLATFORM_CASE_OUTCOMES.includes(outcome as PlatformCaseOutcome)) {
    return { outcome: { kind: "error", message: "Choose an outcome." } };
  }
  if (!note) return { outcome: { kind: "error", message: REASON_MESSAGE } };
  const result = await call<{ resolved: true }>(
    `/billing/reconciliation-cases/${caseId}/resolve`,
    { outcome, note },
  );
  if (result.kind === "ok") {
    revalidatePath("/platform/billing");
    revalidatePath(`/platform/billing/cases/${caseId}`);
  }
  return { outcome: result };
}

// SC3e-2 — re-read the payment provider for the case (no provider write).
export async function recheckCaseAction(
  _previous: BillingActionState<PlatformCaseRecheckResponse>,
  form: FormData,
): Promise<BillingActionState<PlatformCaseRecheckResponse>> {
  const caseId = form.get("caseId");
  if (typeof caseId !== "string" || !UUID.test(caseId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  const outcome = await call<PlatformCaseRecheckResponse>(
    `/billing/reconciliation-cases/${caseId}/recheck`,
  );
  if (outcome.kind === "ok") revalidatePath(`/platform/billing/cases/${caseId}`);
  return { outcome };
}

// SC3e-2 — release THE leftover schedule the case shows (never cancelled;
// billing.schedules.release, a recent sign-in, a reason).
export async function releaseScheduleAction(
  _previous: BillingActionState<PlatformCaseDetailResponse>,
  form: FormData,
): Promise<BillingActionState<PlatformCaseDetailResponse>> {
  const caseId = form.get("caseId");
  const externalScheduleId = form.get("externalScheduleId");
  const reason = validReason(form.get("reason"));
  if (typeof caseId !== "string" || !UUID.test(caseId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (typeof externalScheduleId !== "string" || !/^[A-Za-z0-9_]{1,255}$/.test(externalScheduleId)) {
    return { outcome: { kind: "error", message: "Reload the case to see its schedule." } };
  }
  if (!reason) return { outcome: { kind: "error", message: REASON_MESSAGE } };
  const outcome = await call<PlatformCaseDetailResponse>(
    `/billing/reconciliation-cases/${caseId}/release-schedule`,
    { externalScheduleId, reason },
  );
  if (outcome.kind === "ok") revalidatePath(`/platform/billing/cases/${caseId}`);
  return { outcome };
}

// SC3e-2 — complimentary arrangements (billing.complimentary.manage).
export async function grantComplimentaryAction(
  _previous: BillingActionState<PlatformComplimentaryView>,
  form: FormData,
): Promise<BillingActionState<PlatformComplimentaryView>> {
  const tenantId = form.get("tenantId");
  const planVersionId = form.get("planVersionId");
  const duration = form.get("duration");
  const reason = validReason(form.get("reason"));
  if (typeof tenantId !== "string" || !isTenantId(tenantId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (typeof planVersionId !== "string" || !UUID.test(planVersionId)) {
    return { outcome: { kind: "error", message: "Choose the plan it gets." } };
  }
  const end =
    duration === "indefinite"
      ? ({ ok: true, endsAt: null } as const)
      : duration === "until"
        ? parseEndDate(form.get("endDate"))
        : ({ ok: false, message: "Choose indefinite or an end date." } as const);
  if (!end.ok) return { outcome: { kind: "error", message: end.message } };
  if (!reason) return { outcome: { kind: "error", message: REASON_MESSAGE } };
  const outcome = await call<PlatformComplimentaryView>(
    `/tenants/${encodeURIComponent(tenantId)}/billing/complimentary`,
    { planVersionId, endsAt: end.endsAt, reason },
  );
  if (outcome.kind === "ok") revalidatePath(`/platform/tenants/${tenantId}`);
  return { outcome };
}

export async function endComplimentaryAction(
  _previous: BillingActionState<PlatformComplimentaryView>,
  form: FormData,
): Promise<BillingActionState<PlatformComplimentaryView>> {
  const tenantId = form.get("tenantId");
  const grantId = form.get("grantId");
  const step = form.get("step");
  const reason = validReason(form.get("reason"));
  if (
    typeof tenantId !== "string" ||
    !isTenantId(tenantId) ||
    typeof grantId !== "string" ||
    !UUID.test(grantId) ||
    (step !== "withdraw" && step !== "revoke")
  ) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (!reason) return { outcome: { kind: "error", message: REASON_MESSAGE } };
  const outcome = await call<PlatformComplimentaryView>(
    `/tenants/${encodeURIComponent(tenantId)}/billing/complimentary/${grantId}/${step}`,
    { reason },
  );
  if (outcome.kind === "ok") revalidatePath(`/platform/tenants/${tenantId}`);
  return { outcome };
}

// --- SC3e-3: refunds and credits -----------------------------------------------------

const NOTE_MESSAGE = "Write a note of 10 to 500 characters (one line).";
const LINE = /^[A-Za-z0-9_]{1,255}$/;

// The request body from the form: kind, scope and (partial) one line and a
// pre-tax amount typed in major units.
function adjustmentInput(
  form: FormData,
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const kind = form.get("kind");
  const scope = form.get("scope");
  if (kind !== "REFUND" && kind !== "CREDIT") return { ok: false, message: "Choose a refund or a credit." };
  if (scope === "FULL") return { ok: true, body: { kind, scope } };
  if (scope !== "PARTIAL") return { ok: false, message: "Choose the whole invoice or part of it." };
  const lineId = form.get("lineId");
  const amount = parseAmount(form.get("amount"));
  if (typeof lineId !== "string" || !LINE.test(lineId)) {
    return { ok: false, message: "Choose the invoice line." };
  }
  if (amount === null) {
    return { ok: false, message: "Enter an amount before tax, like 25 or 25.50." };
  }
  return { ok: true, body: { kind, scope, lineId, amountMinorUnits: amount } };
}

function invoicePath(form: FormData): string | null {
  const tenantId = form.get("tenantId");
  const invoiceId = form.get("invoiceId");
  if (typeof tenantId !== "string" || !isTenantId(tenantId)) return null;
  if (typeof invoiceId !== "string" || !UUID.test(invoiceId)) return null;
  return `/tenants/${encodeURIComponent(tenantId)}/billing/invoices/${invoiceId}`;
}

// The payment provider's preview (nothing recorded).
export async function previewAdjustmentAction(
  _previous: BillingActionState<PlatformAdjustmentPreview>,
  form: FormData,
): Promise<BillingActionState<PlatformAdjustmentPreview>> {
  const path = invoicePath(form);
  if (!path) return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  const input = adjustmentInput(form);
  if (!input.ok) return { outcome: { kind: "error", message: input.message } };
  return { outcome: await call<PlatformAdjustmentPreview>(`${path}/adjustments/preview`, input.body) };
}

// Records the request (billing.adjustments.request, a recent sign-in, a
// reason). Nothing is refunded or credited until it is approved.
export async function requestAdjustmentAction(
  _previous: BillingActionState<PlatformAdjustmentView>,
  form: FormData,
): Promise<BillingActionState<PlatformAdjustmentView>> {
  const path = invoicePath(form);
  if (!path) return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  const input = adjustmentInput(form);
  if (!input.ok) return { outcome: { kind: "error", message: input.message } };
  const reason = validNote(form.get("reason"));
  if (!reason) return { outcome: { kind: "error", message: REASON_MESSAGE } };
  if (form.get("understood") !== "yes") {
    return {
      outcome: {
        kind: "error",
        message: "Confirm that you understand a refund or credit doesn't cancel or change the subscription.",
      },
    };
  }
  const outcome = await call<PlatformAdjustmentView>(`${path}/adjustments`, { ...input.body, reason });
  if (outcome.kind === "ok") {
    revalidatePath("/platform/billing/adjustments");
    revalidatePath(`/platform/tenants/${String(form.get("tenantId"))}`);
  }
  return { outcome };
}

// Approve, reject, withdraw (the requester) or resolve as not issued — with
// a note; the API checks who may.
export async function decideAdjustmentAction(
  _previous: BillingActionState<PlatformAdjustmentView>,
  form: FormData,
): Promise<BillingActionState<PlatformAdjustmentView>> {
  const adjustmentId = form.get("adjustmentId");
  const step = form.get("step");
  const note = validNote(form.get("note"));
  if (
    typeof adjustmentId !== "string" ||
    !UUID.test(adjustmentId) ||
    (step !== "approve" && step !== "reject" && step !== "cancel" && step !== "resolve-not-issued")
  ) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  if (!note) return { outcome: { kind: "error", message: NOTE_MESSAGE } };
  if (step === "approve" && form.get("understood") !== "yes") {
    return {
      outcome: {
        kind: "error",
        message: "Confirm that you checked the amount and that the subscription keeps renewing.",
      },
    };
  }
  const outcome = await call<PlatformAdjustmentView>(`/billing/adjustments/${adjustmentId}/${step}`, { note });
  if (outcome.kind === "ok") {
    revalidatePath("/platform/billing/adjustments");
    revalidatePath(`/platform/billing/adjustments/${adjustmentId}`);
    revalidatePath(`/platform/tenants/${outcome.data.tenantId}`);
  }
  return { outcome };
}

// --- SC3e-3: operator permissions (platform.permissions.manage) ----------------------

export async function changePermissionAction(
  _previous: BillingActionState<PlatformOperatorDirectoryResponse>,
  form: FormData,
): Promise<BillingActionState<PlatformOperatorDirectoryResponse>> {
  const operatorId = form.get("operatorId");
  const permission = form.get("permission");
  const step = form.get("step");
  const reason = validNote(form.get("reason"));
  if (typeof operatorId !== "string" || !UUID.test(operatorId) || (step !== "grant" && step !== "revoke")) {
    return { outcome: { kind: "error", message: "That operator could not be found." } };
  }
  if (!PLATFORM_PERMISSIONS.includes(permission as PlatformPermission)) {
    return { outcome: { kind: "error", message: "Choose a permission." } };
  }
  if (!reason) return { outcome: { kind: "error", message: REASON_MESSAGE } };
  const outcome = await call<PlatformOperatorDirectoryResponse>(
    `/operators/${operatorId}/permissions${step === "revoke" ? "/revoke" : ""}`,
    { permission, reason },
  );
  if (outcome.kind === "ok") revalidatePath("/platform/operators");
  return { outcome };
}
