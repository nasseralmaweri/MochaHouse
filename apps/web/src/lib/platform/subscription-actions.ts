"use server";

import { revalidatePath } from "next/cache";
import {
  isOptionalModuleKey,
  type OptionalModuleKey,
  type PlatformPlan,
  type PlatformSubscriptionChangeResponse,
  type PlatformSubscriptionPreviewResponse,
} from "@mocha-house/contracts";
import { getPlatformSessionToken, platformApiUrl } from "@/lib/platform-auth/session";
import { isTenantId } from "./tenant-registry";
import {
  SUBSCRIPTION_MESSAGES,
  interpretChange,
  validatePlanForm,
  type ChangeOutcome,
} from "./subscriptions";

// SC2a — server actions for plans and subscriptions. Each calls the API's
// platform boundary from the server with the operator's HttpOnly session
// (the token never reaches the browser).

export interface ActionState<T> {
  outcome: ChangeOutcome<T> | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function modules(form: FormData): OptionalModuleKey[] {
  return form.getAll("moduleKeys").filter(isOptionalModuleKey);
}

async function call<T>(method: string, path: string, body?: object): Promise<ChangeOutcome<T>> {
  const token = await getPlatformSessionToken();
  if (!token) return { kind: "error", message: SUBSCRIPTION_MESSAGES.sessionEnded };
  try {
    const response = await fetch(`${platformApiUrl()}/platform${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    return interpretChange<T>(response.status, await response.json().catch(() => null));
  } catch {
    return interpretChange<T>(null, null);
  }
}

function refresh<T>(outcome: ChangeOutcome<T>, path: string): ActionState<T> {
  if (outcome.kind === "ok") revalidatePath(path);
  return { outcome };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- plans ---------------------------------------------------------------

export async function createPlanAction(
  _previous: ActionState<PlatformPlan>,
  form: FormData,
): Promise<ActionState<PlatformPlan>> {
  const key = text(form, "key");
  const name = text(form, "name");
  const errors = validatePlanForm(key, name);
  const first = errors.key ?? errors.name;
  if (first) return { outcome: { kind: "error", message: first } };
  return refresh(
    await call<PlatformPlan>("POST", "/plans", {
      key: key.trim().toLowerCase(),
      name: name.trim(),
      description: text(form, "description").trim() || null,
      moduleKeys: modules(form),
    }),
    "/platform/plans",
  );
}

export async function planVersionAction(
  _previous: ActionState<PlatformPlan>,
  form: FormData,
): Promise<ActionState<PlatformPlan>> {
  const planId = text(form, "planId");
  const versionId = text(form, "versionId");
  const intent = text(form, "intent");
  if (!UUID.test(planId) || (intent !== "new-version" && !UUID.test(versionId))) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  const base = `/plans/${planId}/versions`;
  const outcome =
    intent === "new-version"
      ? await call<PlatformPlan>("POST", base, { moduleKeys: modules(form) })
      : intent === "save-draft"
        ? await call<PlatformPlan>("PUT", `${base}/${versionId}`, { moduleKeys: modules(form) })
        : intent === "publish"
          ? await call<PlatformPlan>("POST", `${base}/${versionId}/publish`)
          : intent === "retire"
            ? await call<PlatformPlan>("POST", `${base}/${versionId}/retire`)
            : ({ kind: "error", message: SUBSCRIPTION_MESSAGES.unavailable } as const);
  return refresh(outcome, "/platform/plans");
}

// --- a business's subscription --------------------------------------------

function change(form: FormData): { planVersionId?: string; grant?: OptionalModuleKey; revoke?: OptionalModuleKey } | null {
  const kind = text(form, "change");
  const value = text(form, "value");
  if (kind === "plan" && UUID.test(value)) return { planVersionId: value };
  if ((kind === "grant" || kind === "revoke") && isOptionalModuleKey(value)) {
    return { [kind]: value };
  }
  return null;
}

export async function previewSubscriptionAction(
  _previous: ActionState<PlatformSubscriptionPreviewResponse>,
  form: FormData,
): Promise<ActionState<PlatformSubscriptionPreviewResponse>> {
  const tenantId = text(form, "tenantId");
  const body = change(form);
  if (!isTenantId(tenantId) || !body) {
    return { outcome: { kind: "error", message: "Choose a plan or module first." } };
  }
  return { outcome: await call("POST", `/tenants/${tenantId}/subscription/preview`, body) };
}

export async function applySubscriptionAction(
  _previous: ActionState<PlatformSubscriptionChangeResponse>,
  form: FormData,
): Promise<ActionState<PlatformSubscriptionChangeResponse>> {
  const tenantId = text(form, "tenantId");
  const body = change(form);
  if (!isTenantId(tenantId) || !body) {
    return { outcome: { kind: "error", message: SUBSCRIPTION_MESSAGES.notFound } };
  }
  const base = `/tenants/${tenantId}/subscription`;
  const outcome = body.planVersionId
    ? await call<PlatformSubscriptionChangeResponse>("PUT", base, { planVersionId: body.planVersionId })
    : body.grant
      ? await call<PlatformSubscriptionChangeResponse>("POST", `${base}/add-ons`, { moduleKey: body.grant })
      : await call<PlatformSubscriptionChangeResponse>("DELETE", `${base}/add-ons/${body.revoke}`);
  return refresh(outcome, `/platform/tenants/${tenantId}`);
}
