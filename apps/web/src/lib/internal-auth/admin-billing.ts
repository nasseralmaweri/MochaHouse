import "server-only";
import { cache } from "react";
import type {
  AdminBillingCheckoutResponse,
  AdminBillingResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";
import { checkoutRefusalMessage, isAllowedCheckoutUrl } from "@/lib/admin/billing";

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
