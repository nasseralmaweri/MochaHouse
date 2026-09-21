import "server-only";
import type {
  AdminLocationPerformanceReport,
  AdminOrdersOverviewReport,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only read of the authorized Admin Reports API (Milestone 9A).
// Mirrors lib/internal-auth/admin-platform.ts. The API
// (`GET /api/v1/admin/reports/orders-overview`, InternalAuthGuard +
// PermissionGuard + `reports.view`, CORPORATE-only) is the sole
// authorization authority — this helper never shapes or filters the data
// itself.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminOrdersOverviewReportResult =
  | { outcome: "success"; data: AdminOrdersOverviewReport }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "invalid" }
  | { outcome: "error" };

export async function getAdminOrdersOverviewReport(query: {
  startDate: string;
  endDate: string;
  locationId: string | null;
}): Promise<AdminOrdersOverviewReportResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  const params = new URLSearchParams();
  params.set("startDate", query.startDate);
  params.set("endDate", query.endDate);
  if (query.locationId) {
    params.set("locationId", query.locationId);
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/reports/orders-overview?${params.toString()}`,
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
  if (response.status === 400) {
    return { outcome: "invalid" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    data: (await response.json()) as AdminOrdersOverviewReport,
  };
}

// Milestone 9B — Location Performance. Mirrors getAdminOrdersOverviewReport
// above; the API (`GET /api/v1/admin/reports/location-performance`, same
// InternalAuthGuard + PermissionGuard + `reports.view`) is the sole
// authorization authority.
export type AdminLocationPerformanceReportResult =
  | { outcome: "success"; data: AdminLocationPerformanceReport }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "invalid" }
  | { outcome: "error" };

export async function getAdminLocationPerformanceReport(query: {
  startDate: string;
  endDate: string;
}): Promise<AdminLocationPerformanceReportResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  const params = new URLSearchParams();
  params.set("startDate", query.startDate);
  params.set("endDate", query.endDate);

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/reports/location-performance?${params.toString()}`,
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
  if (response.status === 400) {
    return { outcome: "invalid" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    data: (await response.json()) as AdminLocationPerformanceReport,
  };
}
