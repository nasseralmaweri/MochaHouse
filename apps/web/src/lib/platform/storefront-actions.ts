"use server";

import { revalidatePath } from "next/cache";
import {
  getPlatformSessionToken,
  platformApiUrl,
} from "@/lib/platform-auth/session";
import {
  STOREFRONT_MESSAGES,
  interpretStorefrontChange,
  validId,
  validReason,
  type StorefrontOutcome,
} from "./storefront";

// SC4f-3a — assigning, publishing and unpublishing storefront addresses from
// the console. Posts to the API's platform boundary from the server with the
// operator's HttpOnly session (the token never reaches the browser). The API
// decides: storefront.manage, a recent sign-in, a reason, the business's slug,
// the eligibility checks and who owns which address.

export interface StorefrontFormState {
  outcome: StorefrontOutcome | null;
  fieldError: string | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function post(path: string, body: Record<string, unknown>): Promise<StorefrontOutcome> {
  const token = await getPlatformSessionToken();
  if (!token) return { kind: "error", message: STOREFRONT_MESSAGES.sessionEnded };
  try {
    const response = await fetch(`${platformApiUrl()}/platform${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return interpretStorefrontChange(response.status, await response.json().catch(() => null));
  } catch {
    return interpretStorefrontChange(null, null);
  }
}

function checked(form: FormData): { reason: string; confirmSlug: string } | string {
  const reason = text(form, "reason");
  const confirmSlug = text(form, "confirmSlug").trim();
  if (!validReason(reason)) return STOREFRONT_MESSAGES.reason;
  if (confirmSlug === "") return STOREFRONT_MESSAGES.slug;
  return { reason: reason.trim(), confirmSlug };
}

export async function storefrontAction(
  _previous: StorefrontFormState,
  form: FormData,
): Promise<StorefrontFormState> {
  const tenantId = form.get("tenantId");
  const intent = text(form, "intent");
  if (!validId(tenantId)) {
    return { outcome: { kind: "error", message: STOREFRONT_MESSAGES.unavailable }, fieldError: null };
  }
  const input = checked(form);
  if (typeof input === "string") return { outcome: null, fieldError: input };

  const base = `/tenants/${encodeURIComponent(tenantId)}/storefront`;
  let outcome: StorefrontOutcome;
  if (intent === "assign-platform") {
    outcome = await post(`${base}/hosts`, { kind: "PLATFORM_SUBDOMAIN", ...input });
  } else if (intent === "assign-legacy") {
    const hostname = text(form, "hostname");
    if (hostname === "") return { outcome: null, fieldError: "Choose an approved address." };
    outcome = await post(`${base}/hosts`, { kind: "LEGACY", hostname, ...input });
  } else if (intent === "publish" || intent === "unpublish") {
    const hostId = form.get("hostId");
    if (!validId(hostId)) {
      return { outcome: { kind: "error", message: STOREFRONT_MESSAGES.unavailable }, fieldError: null };
    }
    outcome = await post(`${base}/hosts/${encodeURIComponent(hostId)}/${intent}`, input);
  } else {
    return { outcome: { kind: "error", message: STOREFRONT_MESSAGES.unavailable }, fieldError: null };
  }
  if (outcome.kind === "ok") revalidatePath(`/platform/tenants/${tenantId}/storefront`);
  return { outcome, fieldError: null };
}
