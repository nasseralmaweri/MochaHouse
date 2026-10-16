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

async function call<T>(path: string, body?: object): Promise<ChangeOutcome<T>> {
  const token = await getPlatformSessionToken();
  if (!token) return { kind: "error", message: SUBSCRIPTION_MESSAGES.sessionEnded };
  try {
    const response = await fetch(`${platformApiUrl()}/platform${path}`, {
      method: "POST",
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
