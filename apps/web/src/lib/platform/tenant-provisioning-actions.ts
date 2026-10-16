"use server";

import type { PlatformTenantProvisionResponse } from "@mocha-house/contracts";
import {
  getPlatformSessionToken,
  platformApiUrl,
} from "@/lib/platform-auth/session";
import {
  PROVISION_MESSAGES,
  interpretProvision,
  isOperationKey,
  normaliseEmail,
  validateProvision,
  type ProvisionFieldErrors,
  type ProvisionValues,
} from "./tenant-provisioning";

// SC1d — "Add a business": posts to the API's platform boundary from the
// server, with the operator's HttpOnly session (the token never reaches the
// browser) and the form's operation key as the Idempotency-Key. The key is
// minted when the page is rendered, so a double submit or a retry after a
// network failure is the SAME operation and can never create two businesses.

export interface ProvisionFormState {
  values: ProvisionValues;
  errors: ProvisionFieldErrors;
  message: string | null;
  created: PlatformTenantProvisionResponse | null;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function provisionTenantAction(
  _previous: ProvisionFormState,
  form: FormData,
): Promise<ProvisionFormState> {
  const values: ProvisionValues = {
    name: field(form, "name"),
    slug: field(form, "slug"),
    ownerEmail: field(form, "ownerEmail"),
    ownerEmailConfirm: field(form, "ownerEmailConfirm"),
    ownerDisplayName: field(form, "ownerDisplayName"),
    planVersionId: field(form, "planVersionId"),
  };
  const operationKey = form.get("operationKey");
  const fail = (
    message: string | null,
    errors: ProvisionFieldErrors = {},
  ): ProvisionFormState => ({ values, errors, message, created: null });

  if (!isOperationKey(operationKey)) {
    return fail(PROVISION_MESSAGES.keyReused);
  }
  const errors = validateProvision(values);
  if (Object.keys(errors).length > 0) {
    return fail(PROVISION_MESSAGES.invalid, errors);
  }
  const token = await getPlatformSessionToken();
  if (!token) {
    return fail(PROVISION_MESSAGES.sessionEnded);
  }

  let status: number | null = null;
  let body: unknown = null;
  try {
    const response = await fetch(`${platformApiUrl()}/platform/tenants`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": operationKey,
      },
      body: JSON.stringify({
        name: values.name,
        slug: values.slug,
        ownerEmail: normaliseEmail(values.ownerEmail),
        ownerDisplayName: values.ownerDisplayName.trim() || null,
        planVersionId: values.planVersionId,
      }),
      cache: "no-store",
    });
    status = response.status;
    body = await response.json().catch(() => null);
  } catch {
    status = null;
  }

  const outcome = interpretProvision(status, body);
  switch (outcome.kind) {
    case "created":
      return { values, errors: {}, message: null, created: outcome.result };
    case "field":
      return fail(PROVISION_MESSAGES.invalid, { [outcome.field]: outcome.message });
    default:
      return fail(outcome.message);
  }
}
