import "server-only";
import { cache } from "react";
import type {
  AdminBillingCheckoutResponse,
  AdminBillingRecoveryResponse,
  AdminBillingResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";
import {
  checkoutRefusalMessage,
  isAllowedCheckoutUrl,
  BILLING_MESSAGES,
  isAllowedRecoveryUrl,
} from "@/lib/admin/billing";

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
