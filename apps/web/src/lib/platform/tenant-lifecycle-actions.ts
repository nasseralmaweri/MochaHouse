"use server";

import { revalidatePath } from "next/cache";
import {
  getPlatformSessionToken,
  platformApiUrl,
} from "@/lib/platform-auth/session";
import { isTenantId } from "./tenant-registry";
import { normaliseEmail, validateProvision } from "./tenant-provisioning";
import {
  LIFECYCLE_MESSAGES,
  confirmsSlug,
  interpretLifecycleChange,
  isSuspensionReason,
  type LifecycleOutcome,
} from "./tenant-lifecycle";

// SC1e — the lifecycle panel's server actions. Each posts to the API's
// platform boundary from the server with the operator's HttpOnly session
// (the token never reaches the browser), then refreshes the tenant page.

export interface LifecycleFormState {
  outcome: LifecycleOutcome | null;
  // A field-level problem found before any request was made.
  fieldError: string | null;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function post(path: string, body: object): Promise<LifecycleOutcome> {
  const token = await getPlatformSessionToken();
  if (!token) return { kind: "error", message: LIFECYCLE_MESSAGES.sessionEnded };
  try {
    const response = await fetch(`${platformApiUrl()}/platform/tenants/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return interpretLifecycleChange(
      response.status,
      await response.json().catch(() => null),
    );
  } catch {
    return interpretLifecycleChange(null, null);
  }
}

function finish(tenantId: string, outcome: LifecycleOutcome): LifecycleFormState {
  if (outcome.kind === "done") revalidatePath(`/platform/tenants/${tenantId}`);
  return { outcome, fieldError: null };
}

export async function suspendTenantAction(
  _previous: LifecycleFormState,
  form: FormData,
): Promise<LifecycleFormState> {
  const tenantId = field(form, "tenantId");
  if (!isTenantId(tenantId)) {
    return { outcome: { kind: "error", message: LIFECYCLE_MESSAGES.notFound }, fieldError: null };
  }
  const reason = field(form, "reason");
  if (!isSuspensionReason(reason)) {
    return { outcome: null, fieldError: LIFECYCLE_MESSAGES.chooseReason };
  }
  if (!confirmsSlug(field(form, "confirmSlug"), field(form, "slug"))) {
    return { outcome: null, fieldError: LIFECYCLE_MESSAGES.confirmSlug };
  }
  return finish(tenantId, await post(`${tenantId}/suspend`, { reason }));
}

export async function reactivateTenantAction(
  _previous: LifecycleFormState,
  form: FormData,
): Promise<LifecycleFormState> {
  const tenantId = field(form, "tenantId");
  if (!isTenantId(tenantId)) {
    return { outcome: { kind: "error", message: LIFECYCLE_MESSAGES.notFound }, fieldError: null };
  }
  return finish(tenantId, await post(`${tenantId}/reactivate`, {}));
}

export async function correctOwnerEmailAction(
  _previous: LifecycleFormState,
  form: FormData,
): Promise<LifecycleFormState> {
  const tenantId = field(form, "tenantId");
  const ownerId = field(form, "ownerId");
  if (!isTenantId(tenantId) || !isTenantId(ownerId)) {
    return { outcome: { kind: "error", message: LIFECYCLE_MESSAGES.notFound }, fieldError: null };
  }
  const email = field(form, "email");
  const emailConfirm = field(form, "emailConfirm");
  // The same email rules as "Add a business".
  const errors = validateProvision({
    name: "valid name",
    slug: "valid-slug",
    ownerEmail: email,
    ownerEmailConfirm: emailConfirm,
    ownerDisplayName: "",
  });
  const fieldError = errors.ownerEmail ?? errors.ownerEmailConfirm ?? null;
  if (fieldError) return { outcome: null, fieldError };
  return finish(
    tenantId,
    await post(`${tenantId}/owner-email`, { ownerId, email: normaliseEmail(email) }),
  );
}
