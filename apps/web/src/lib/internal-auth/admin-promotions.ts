import "server-only";
import type {
  AdminPromotionOptions,
  AdminPromotionsResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Promotions & Coupons API (Milestone 7E). The
// API (`/api/v1/admin/promotions*`, InternalAuthGuard + PermissionGuard +
// `promotions.configure`, CORPORATE-only) is the sole authorization
// authority — this helper never queries Prisma and never bypasses the API.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

type ReadResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

async function get<T>(path: string): Promise<ReadResult<T>> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/promotions${path}`, {
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

export function getAdminPromotions() {
  return get<AdminPromotionsResponse>("");
}

export function getPromotionOptions() {
  return get<AdminPromotionOptions>("/options");
}
