import "server-only";
import type {
  AdminJobOpening,
  AdminJobOpeningOptions,
  AdminJobOpeningsResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Careers API (Milestone 8B). The API
// (`/api/v1/admin/careers/jobs*`, `careers.view` / `careers.manage`,
// CORPORATE-only) is the sole authorization authority. Browser mutations go
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
    response = await fetch(`${getApiUrl()}/admin/careers/jobs${path}`, {
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

export function getAdminJobOpenings(
  status?: string,
): Promise<ReadResult<AdminJobOpeningsResponse>> {
  return read<AdminJobOpeningsResponse>(
    status ? `?status=${encodeURIComponent(status)}` : "",
  );
}

export function getAdminJobOpeningOptions(): Promise<
  ReadResult<AdminJobOpeningOptions>
> {
  return read<AdminJobOpeningOptions>("/options");
}

export function getAdminJobOpening(
  jobId: string,
): Promise<ReadResult<AdminJobOpening>> {
  return read<AdminJobOpening>(`/${encodeURIComponent(jobId)}`);
}
