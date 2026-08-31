import "server-only";
import type { AdminPlatformStatus } from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only read of the authorized Admin Platform Status API (Milestone
// 5G). Mirrors lib/internal-auth/admin-audit.ts. The API
// (`GET /api/v1/admin/platform/status`, InternalAuthGuard + PermissionGuard
// + `platform.view`, CORPORATE-only) is the sole authorization authority —
// this helper never reads configuration itself.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminPlatformStatusResult =
  | { outcome: "success"; data: AdminPlatformStatus }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getAdminPlatformStatus(): Promise<AdminPlatformStatusResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/platform/status`, {
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
    data: (await response.json()) as AdminPlatformStatus,
  };
}
