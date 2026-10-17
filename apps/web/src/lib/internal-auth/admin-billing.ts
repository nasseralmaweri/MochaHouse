import "server-only";
import { cache } from "react";
import type {
  AdminInitialPlanChangeRequest,
  AdminInitialPlanOptionsResponse,
  AdminPlanOption,
  AdminPlanOptionsResponse,
  BillingPlanChangeConfirmResponse,
  BillingPlanChangePreview,
  AdminBillingCheckoutResponse,
  AdminBillingRecoveryResponse,
  AdminBillingResponse,
  AdminBillingPaymentMethodResponse,
  BillingInvoiceDocumentKind,
  BillingInvoiceListResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";
import {
  checkoutRefusalMessage,
  isAllowedCheckoutUrl,
  BILLING_MESSAGES,
  isAllowedRecoveryUrl,
  isAllowedInvoiceDocumentUrl,
} from "@/lib/admin/billing";
import { documentRefusalMessage } from "@/lib/admin/billing-history";
import { planChangeRefusalMessage } from "@/lib/admin/plan-change";

// SC3b — server-only calls to the business's own billing API. The API is the
// sole authority (InternalAuthGuard + PermissionGuard + billing.view /
// billing.manage, the business from the authenticated session). Nothing
// here sends a business, price or provider id: the API reads none.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error("API_URL environment variable is not set. See apps/web/.env.example.");
  }
  return apiUrl;
}

export type AdminBillingResult =
  | { outcome: "success"; data: AdminBillingResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

// Cached per request (React): the admin layout's billing notice and the
// billing page share one read.
export const getAdminBilling = cache(async function getAdminBilling(): Promise<AdminBillingResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "unauthenticated" };
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/billing`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) return { outcome: "unauthenticated" };
  if (response.status === 403) return { outcome: "forbidden" };
  if (response.status === 404) return { outcome: "not-found" };
  if (!response.ok) return { outcome: "error" };
  return { outcome: "success", data: (await response.json()) as AdminBillingResponse };
});

// SC3c-2 — the provider's hosted page for the outstanding invoice, or a
// Customer Portal session. The request carries nothing; the returned page
// is checked against the provider's own hosts.
export async function openAdminBillingRecovery(
  kind: "invoice" | "portal",
): Promise<OpenCheckoutResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "refused", message: checkoutRefusalMessage(401, null) };
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/billing/recovery/${kind}`, {
      method: "POST",
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "refused", message: BILLING_MESSAGES.recoveryUnavailable };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message = checkoutRefusalMessage(response.status, body);
    return {
      outcome: "refused",
      message: message === BILLING_MESSAGES.unavailable ? BILLING_MESSAGES.recoveryUnavailable : message,
    };
  }
  const url = (body as AdminBillingRecoveryResponse | null)?.url;
  if (!isAllowedRecoveryUrl(url, kind)) {
    return { outcome: "refused", message: BILLING_MESSAGES.recoveryUnavailable };
  }
  return { outcome: "redirect", url };
}

// --- SC3e-1: billing history --------------------------------------------------------
// The request carries only the API's own page cursor or OUR invoice id; the
// API decides the business and checks the invoice is its own.

export type AdminInvoicesResult =
  | { outcome: "success"; data: BillingInvoiceListResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "invalid-page" }
  | { outcome: "error" };

export async function getAdminInvoices(cursor: string | null): Promise<AdminInvoicesResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "unauthenticated" };
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/billing/invoices${query}`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) return { outcome: "unauthenticated" };
  if (response.status === 403) return { outcome: "forbidden" };
  if (response.status === 400) return { outcome: "invalid-page" };
  if (!response.ok) return { outcome: "error" };
  try {
    return { outcome: "success", data: (await response.json()) as BillingInvoiceListResponse };
  } catch {
    return { outcome: "error" };
  }
}

export type AdminPaymentMethodResult =
  | { outcome: "success"; data: AdminBillingPaymentMethodResponse }
  | { outcome: "unavailable" };

export async function getAdminPaymentMethod(): Promise<AdminPaymentMethodResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "unavailable" };
  try {
    const response = await fetch(`${getApiUrl()}/admin/billing/payment-method`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
    if (!response.ok) return { outcome: "unavailable" };
    return { outcome: "success", data: (await response.json()) as AdminBillingPaymentMethodResponse };
  } catch {
    return { outcome: "unavailable" };
  }
}

// The provider's own page or PDF for one invoice (checked against the
// provider's hosts before the browser is sent there).
export async function openAdminInvoiceDocument(
  invoiceId: string,
  kind: BillingInvoiceDocumentKind,
): Promise<OpenCheckoutResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "refused", message: documentRefusalMessage(401, null) };
  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/billing/invoices/${encodeURIComponent(invoiceId)}/document`,
      {
        method: "POST",
        headers: { ...(await internalAuthHeaders(token)), "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
        cache: "no-store",
      },
    );
  } catch {
    return { outcome: "refused", message: documentRefusalMessage(null, null) };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    return { outcome: "refused", message: documentRefusalMessage(response.status, body) };
  }
  const url = (body as AdminBillingRecoveryResponse | null)?.url;
  if (!isAllowedInvoiceDocumentUrl(url, kind)) {
    return { outcome: "refused", message: documentRefusalMessage(null, null) };
  }
  return { outcome: "redirect", url };
}

export type OpenCheckoutResult =
  | { outcome: "redirect"; url: string }
  | { outcome: "refused"; message: string };

export async function openAdminBillingCheckout(): Promise<OpenCheckoutResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "refused", message: checkoutRefusalMessage(401, null) };
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/billing/checkout`, {
      method: "POST",
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "refused", message: checkoutRefusalMessage(null, null) };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    return { outcome: "refused", message: checkoutRefusalMessage(response.status, body) };
  }
  const url = (body as AdminBillingCheckoutResponse | null)?.url;
  if (!isAllowedCheckoutUrl(url)) {
    return { outcome: "refused", message: checkoutRefusalMessage(null, null) };
  }
  return { outcome: "redirect", url };
}

// --- SC3d-2: plan changes ------------------------------------------------------------
// The request carries only OUR price id (preview) or OUR preview id
// (confirm); the API decides the business, the provider ids and the charge.

export async function getAdminPlanOptions(): Promise<AdminPlanOption[] | null> {
  const token = await getInternalSessionToken();
  if (!token) return null;
  try {
    const response = await fetch(`${getApiUrl()}/admin/billing/plan-options`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return ((await response.json()) as AdminPlanOptionsResponse).options;
  } catch {
    return null;
  }
}

export type PlanChangeCallResult<T> =
  | { outcome: "ok"; data: T }
  | { outcome: "refused"; message: string; code?: string };

async function postPlanChange<T>(path: string, body?: object): Promise<PlanChangeCallResult<T>> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "refused", message: planChangeRefusalMessage(401, null) };
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/billing/${path}`, {
      method: "POST",
      headers: {
        ...(await internalAuthHeaders(token)),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    return { outcome: "refused", message: planChangeRefusalMessage(null, null) };
  }
  const json = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || json === null) {
    const code =
      typeof json === "object" && json !== null ? (json as { code?: unknown }).code : undefined;
    return {
      outcome: "refused",
      message: planChangeRefusalMessage(response.status, json),
      code: typeof code === "string" ? code : undefined,
    };
  }
  return { outcome: "ok", data: json as T };
}

export function previewAdminPlanChange(
  planPriceId: string,
): Promise<PlanChangeCallResult<BillingPlanChangePreview>> {
  return postPlanChange("plan-change/preview", { planPriceId });
}

export function confirmAdminPlanChange(
  previewId: string,
): Promise<PlanChangeCallResult<BillingPlanChangeConfirmResponse>> {
  return postPlanChange("plan-change/confirm", { previewId });
}

// SC3d-3 — withdraw a scheduled change (only OUR id).
export function cancelAdminPlanChange(
  planChangeId: string,
): Promise<PlanChangeCallResult<BillingPlanChangeConfirmResponse>> {
  return postPlanChange("plan-change/cancel", { planChangeId });
}

// The provider's own hosted page for the waiting change's invoice (checked
// against the provider's host).
export async function openAdminPlanChangePayment(): Promise<OpenCheckoutResult> {
  const result = await postPlanChange<AdminBillingRecoveryResponse>("plan-change/pay");
  if (result.outcome === "refused") return { outcome: "refused", message: result.message };
  if (!isAllowedRecoveryUrl(result.data.url, "invoice")) {
    return { outcome: "refused", message: planChangeRefusalMessage(null, null) };
  }
  return { outcome: "redirect", url: result.data.url };
}

// SC4c — the plans an owner may choose before the first payment setup.
export async function getAdminInitialPlanOptions(): Promise<AdminInitialPlanOptionsResponse | null> {
  const token = await getInternalSessionToken();
  if (!token) return null;
  try {
    const response = await fetch(`${getApiUrl()}/admin/billing/initial-plan-options`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
    return response.ok ? ((await response.json()) as AdminInitialPlanOptionsResponse) : null;
  } catch {
    return null;
  }
}

// SC4c — change the plan and price (as shown) before the first payment
// setup. The API refuses anything not offered or not exactly as shown.
export async function changeAdminInitialPlan(
  request: AdminInitialPlanChangeRequest,
): Promise<{ outcome: "changed" } | { outcome: "refused"; message: string }> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "refused", message: checkoutRefusalMessage(401, null) };
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/billing/initial-plan`, {
      method: "POST",
      headers: { ...(await internalAuthHeaders(token)), "Content-Type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
    });
  } catch {
    return { outcome: "refused", message: BILLING_MESSAGES.unavailable };
  }
  if (response.ok) return { outcome: "changed" };
  return {
    outcome: "refused",
    message: checkoutRefusalMessage(response.status, await response.json().catch(() => null)),
  };
}
