import "server-only";
import type {
  AdminGiftCardDetail,
  AdminGiftCardSearchResponse,
  GiftCardConfiguration,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Gift Card API (Milestone 7F). The API
// (`/api/v1/admin/gift-cards*`, InternalAuthGuard + PermissionGuard,
// CORPORATE-only) is the sole authorization authority — this helper never
// queries Prisma and never bypasses the API. Note the gift-card SEARCH is a
// POST (the code must not appear in a URL/query string), unlike the loyalty
// customer lookup.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type GiftCardSearchResult =
  | { outcome: "success"; data: AdminGiftCardSearchResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "invalid" }
  | { outcome: "error" };

export async function searchGiftCards(
  input: { code?: string; giftCardId?: string },
): Promise<GiftCardSearchResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/gift-cards/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
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
  if (response.status === 400) {
    return { outcome: "invalid" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    data: (await response.json()) as AdminGiftCardSearchResponse,
  };
}

export type GiftCardDetailResult =
  | { outcome: "success"; data: AdminGiftCardDetail }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

export async function getGiftCardDetail(
  giftCardId: string,
): Promise<GiftCardDetailResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/gift-cards/${encodeURIComponent(giftCardId)}`,
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
    data: (await response.json()) as AdminGiftCardDetail,
  };
}

export type GiftCardConfigurationResult =
  | { outcome: "success"; data: GiftCardConfiguration }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getGiftCardConfiguration(): Promise<GiftCardConfigurationResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/gift-cards/configuration`, {
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

  return {
    outcome: "success",
    data: (await response.json()) as GiftCardConfiguration,
  };
}
