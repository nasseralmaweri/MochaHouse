import "server-only";
import type {
  AdminLoyaltyBonusPromotionOptions,
  AdminLoyaltyBonusPromotionsResponse,
  AdminLoyaltyCatalogOptions,
  AdminLoyaltyCustomerDetail,
  AdminLoyaltyCustomerSearchResponse,
  AdminLoyaltyRewardsResponse,
  LoyaltySettings,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Mocha Beans API (Milestone 7A). The API
// (`/api/v1/admin/loyalty/*`, InternalAuthGuard + PermissionGuard +
// `loyalty.view`, CORPORATE-only) is the sole authorization authority —
// this helper never queries Prisma and never bypasses the API.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminLoyaltySearchResult =
  | { outcome: "success"; data: AdminLoyaltyCustomerSearchResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "invalid" }
  | { outcome: "error" };

export async function searchLoyaltyCustomers(
  query: string,
): Promise<AdminLoyaltySearchResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/loyalty/customers?query=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 400) {
    return { outcome: "invalid" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    data: (await response.json()) as AdminLoyaltyCustomerSearchResponse,
  };
}

export type AdminLoyaltyDetailResult =
  | { outcome: "success"; data: AdminLoyaltyCustomerDetail }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

export async function getLoyaltyCustomerDetail(
  customerId: string,
): Promise<AdminLoyaltyDetailResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/loyalty/customers/${encodeURIComponent(customerId)}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    data: (await response.json()) as AdminLoyaltyCustomerDetail,
  };
}

// --- Milestone 7B: settings + rewards (loyalty.configure) ----------

type ConfigureReadResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

async function configureGet<T>(path: string): Promise<ConfigureReadResult<T>> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/loyalty/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return { outcome: "success", data: (await response.json()) as T };
}

export function getLoyaltySettings() {
  return configureGet<LoyaltySettings>("settings");
}

export function getAdminLoyaltyRewards() {
  return configureGet<AdminLoyaltyRewardsResponse>("rewards");
}

export function getLoyaltyCatalogOptions() {
  return configureGet<AdminLoyaltyCatalogOptions>("catalog-options");
}

// --- Milestone 7D: Bonus Mocha Beans Promotions (loyalty.configure) ---

export function getAdminLoyaltyBonusPromotions() {
  return configureGet<AdminLoyaltyBonusPromotionsResponse>("bonus-promotions");
}

export function getLoyaltyBonusPromotionOptions() {
  return configureGet<AdminLoyaltyBonusPromotionOptions>(
    "bonus-promotion-options",
  );
}
