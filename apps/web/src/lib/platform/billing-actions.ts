"use server";

import { revalidatePath } from "next/cache";
import type {
  PlatformReconciliationRunResponse,
  PlatformTenantBillingResponse,
} from "@mocha-house/contracts";
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

export async function resolveCaseAction(
  _previous: BillingActionState<{ resolved: true }>,
  form: FormData,
): Promise<BillingActionState<{ resolved: true }>> {
  const caseId = form.get("caseId");
  if (typeof caseId !== "string" || !UUID.test(caseId)) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  const outcome = await call<{ resolved: true }>(
    `/billing/reconciliation-cases/${caseId}/resolve`,
  );
  if (outcome.kind === "ok") revalidatePath("/platform/billing");
  return { outcome };
}
