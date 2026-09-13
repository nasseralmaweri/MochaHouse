import "server-only";
import type {
  AdminCampaign,
  AdminCampaignOptions,
  AdminCampaignsResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the HQ Marketing API (Milestone 8G). The API
// (`/api/v1/admin/marketing/campaigns*`, `marketing.view` /
// `marketing.manage`, CORPORATE-only) is the sole authorization authority —
// this helper never queries Prisma. Browser writes (create, edit, status)
// go through the generic /api/internal/admin proxy (see lib/api-client.ts).

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
    response = await fetch(`${getApiUrl()}/admin/marketing/campaigns${path}`, {
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

export function getAdminCampaigns(
  status?: string,
): Promise<ReadResult<AdminCampaignsResponse>> {
  return read<AdminCampaignsResponse>(
    status ? `?status=${encodeURIComponent(status)}` : "",
  );
}

export function getAdminCampaignOptions(): Promise<
  ReadResult<AdminCampaignOptions>
> {
  return read<AdminCampaignOptions>("/options");
}

export function getAdminCampaign(
  campaignId: string,
): Promise<ReadResult<AdminCampaign>> {
  return read<AdminCampaign>(`/${encodeURIComponent(campaignId)}`);
}
