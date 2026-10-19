import "server-only";
import type {
  AdminPaymentAccountResponse,
  AdminPaymentOnboardingResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";
import {
  isAllowedOnboardingUrl,
  paymentsRefusalMessage,
} from "@/lib/admin/payments";

// ESP-04 M1 — the restaurant's own Stripe account (Admin > Payments). The API
// is the sole authority (InternalAuthGuard + PermissionGuard +
// payments.connect + owner role); these calls carry no business, account or
// URL of their own.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminPaymentAccountResult =
  | { outcome: "success"; data: AdminPaymentAccountResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

// The account as last read back from Stripe, or — with `refresh` — read back
// from Stripe now (on return from onboarding).
export async function getAdminPaymentAccount({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<AdminPaymentAccountResult> {
  const token = await getInternalSessionToken();
  if (!token) return { outcome: "unauthenticated" };
  try {
    const response = await fetch(
      `${getApiUrl()}/admin/payments/account${refresh ? "/refresh" : ""}`,
      {
        method: refresh ? "POST" : "GET",
        headers: await internalAuthHeaders(token),
        cache: "no-store",
      },
    );
    if (response.status === 401) return { outcome: "unauthenticated" };
    if (response.status === 403) return { outcome: "forbidden" };
    if (!response.ok) return { outcome: "error" };
    return {
      outcome: "success",
      data: (await response.json()) as AdminPaymentAccountResponse,
    };
  } catch {
    return { outcome: "error" };
  }
}

export type OpenOnboardingResult =
  | { outcome: "redirect"; url: string }
  | { outcome: "refused"; message: string };

// Connect (or continue setting up) the restaurant's Stripe account: Stripe's
// hosted onboarding page.
export async function openPaymentOnboarding(): Promise<OpenOnboardingResult> {
  const token = await getInternalSessionToken();
  if (!token)
    return { outcome: "refused", message: paymentsRefusalMessage(401, null) };
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/payments/account/onboarding`, {
      method: "POST",
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "refused", message: paymentsRefusalMessage(null, null) };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    return {
      outcome: "refused",
      message: paymentsRefusalMessage(response.status, body),
    };
  }
  const url = (body as AdminPaymentOnboardingResponse | null)?.url;
  if (!isAllowedOnboardingUrl(url)) {
    return { outcome: "refused", message: paymentsRefusalMessage(null, null) };
  }
  return { outcome: "redirect", url };
}
