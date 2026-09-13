import "server-only";
import type {
  AdminMediaAsset,
  AdminMediaAssetsResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Media Library API (Milestone 8F; get-one
// added in 8I). The API (`/api/v1/admin/media*`, InternalAuthGuard +
// PermissionGuard + `media.view`, CORPORATE-only) is the sole authorization
// authority. Browser writes (upload, metadata update, deactivate) go
// through lib/api-client.ts.

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
  | { outcome: "not-found" }
  | { outcome: "error" };

async function read<T>(path: string): Promise<ReadResult<T>> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/media${path}`, {
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
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return { outcome: "success", data: (await response.json()) as T };
}

export function getAdminMediaAssets(
  params: { q?: string } = {},
): Promise<ReadResult<AdminMediaAssetsResponse>> {
  const search = new URLSearchParams();
  if (params.q && params.q.trim().length > 0) {
    search.set("q", params.q.trim());
  }
  const qs = search.toString();
  return read<AdminMediaAssetsResponse>(qs.length > 0 ? `?${qs}` : "");
}

export function getAdminMediaAsset(
  mediaAssetId: string,
): Promise<ReadResult<{ asset: AdminMediaAsset }>> {
  return read<{ asset: AdminMediaAsset }>(`/${encodeURIComponent(mediaAssetId)}`);
}
