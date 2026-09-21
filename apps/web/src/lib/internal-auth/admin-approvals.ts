import "server-only";
import type {
  AdminApprovalRequest,
  AdminApprovalRequestsResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Approvals API (Milestone 8J). The API
// (`/api/v1/admin/approvals*`, InternalAuthGuard + PermissionGuard +
// `approvals.view` — and, for this slice's only target type, ALSO
// `marketing.view` — CORPORATE-only) is the sole authorization authority.
// Browser writes (approve, reject) go through the generic
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
    response = await fetch(`${getApiUrl()}/admin/approvals${path}`, {
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

export function getAdminApprovals(
  params: { status?: string } = {},
): Promise<ReadResult<AdminApprovalRequestsResponse>> {
  const search = new URLSearchParams();
  if (params.status) {
    search.set("status", params.status);
  }
  const qs = search.toString();
  return read<AdminApprovalRequestsResponse>(qs.length > 0 ? `?${qs}` : "");
}

export function getAdminApprovalRequest(
  approvalRequestId: string,
): Promise<ReadResult<{ approvalRequest: AdminApprovalRequest }>> {
  return read<{ approvalRequest: AdminApprovalRequest }>(
    `/${encodeURIComponent(approvalRequestId)}`,
  );
}
