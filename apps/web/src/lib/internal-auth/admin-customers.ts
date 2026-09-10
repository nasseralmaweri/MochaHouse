import "server-only";
import type {
  AdminCustomerDetail,
  AdminCustomerListResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ CRM API (Milestone 8A). The API
// (`/api/v1/admin/customers*`, InternalAuthGuard + PermissionGuard +
// `customers.view`, CORPORATE-only) is the sole authorization authority —
// this helper never queries Prisma and never bypasses the API. The
// browser add-note write goes through the generic /api/internal/admin proxy
// (see lib/api-client.ts).

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
    response = await fetch(`${getApiUrl()}/admin/customers${path}`, {
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

export function getAdminCustomers(params: {
  q?: string;
  cursor?: string;
}): Promise<ReadResult<AdminCustomerListResponse>> {
  const search = new URLSearchParams();
  if (params.q && params.q.trim().length > 0) {
    search.set("q", params.q.trim());
  }
  if (params.cursor) {
    search.set("cursor", params.cursor);
  }
  const qs = search.toString();
  return read<AdminCustomerListResponse>(qs.length > 0 ? `?${qs}` : "");
}

export function getAdminCustomerDetail(
  customerId: string,
): Promise<ReadResult<AdminCustomerDetail>> {
  return read<AdminCustomerDetail>(`/${encodeURIComponent(customerId)}`);
}
