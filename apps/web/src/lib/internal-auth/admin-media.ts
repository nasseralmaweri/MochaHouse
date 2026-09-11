import "server-only";
import type { AdminMediaAssetsResponse } from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Media Library API (Milestone 8F). The API
// (`/api/v1/admin/media*`, InternalAuthGuard + PermissionGuard +
// `media.view`, CORPORATE-only) is the sole authorization authority.
// Browser writes (upload, deactivate) go through lib/api-client.ts.

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

export async function getAdminMediaAssets(): Promise<
  ReadResult<AdminMediaAssetsResponse>
> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/media`, {
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
    data: (await response.json()) as AdminMediaAssetsResponse,
  };
}
