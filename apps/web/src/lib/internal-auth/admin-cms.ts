import "server-only";
import type {
  AdminCmsPageDetail,
  AdminCmsPagesResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Content (CMS) API (Milestone 8E). The API
// (`/api/v1/admin/content*`, InternalAuthGuard + PermissionGuard +
// `cms.view`, CORPORATE-only) is the sole authorization authority — this
// helper never queries Prisma. Browser writes (save draft, publish) go
// through the generic /api/internal/admin proxy (see lib/api-client.ts).

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
    response = await fetch(`${getApiUrl()}/admin/content${path}`, {
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

export function getAdminCmsPages(): Promise<ReadResult<AdminCmsPagesResponse>> {
  return read<AdminCmsPagesResponse>("");
}

export function getAdminCmsPage(
  pageKey: string,
): Promise<ReadResult<AdminCmsPageDetail>> {
  return read<AdminCmsPageDetail>(`/${encodeURIComponent(pageKey)}`);
}
