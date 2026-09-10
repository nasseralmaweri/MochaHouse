import "server-only";
import type {
  AdminJobApplicationDetail,
  AdminJobApplicationsResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Applicants API (Milestone 8C). The API
// (`/api/v1/admin/careers/applications*`, InternalAuthGuard +
// PermissionGuard + `applicants.view`, CORPORATE-only) is the sole
// authorization authority — this helper never queries Prisma. Browser
// writes (status change, add note) go through the generic
// /api/internal/admin proxy (see lib/api-client.ts).

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
    response = await fetch(
      `${getApiUrl()}/admin/careers/applications${path}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      },
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
  return { outcome: "success", data: (await response.json()) as T };
}

export function getAdminJobApplications(params: {
  status?: string;
  jobOpeningId?: string;
  cursor?: string;
}): Promise<ReadResult<AdminJobApplicationsResponse>> {
  const search = new URLSearchParams();
  if (params.status && params.status.trim().length > 0) {
    search.set("status", params.status.trim());
  }
  if (params.jobOpeningId && params.jobOpeningId.trim().length > 0) {
    search.set("jobOpeningId", params.jobOpeningId.trim());
  }
  if (params.cursor) {
    search.set("cursor", params.cursor);
  }
  const qs = search.toString();
  return read<AdminJobApplicationsResponse>(qs.length > 0 ? `?${qs}` : "");
}

export function getAdminJobApplication(
  applicationId: string,
): Promise<ReadResult<AdminJobApplicationDetail>> {
  return read<AdminJobApplicationDetail>(
    `/${encodeURIComponent(applicationId)}`,
  );
}
