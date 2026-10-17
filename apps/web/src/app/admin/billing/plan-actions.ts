"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type {
  AdminPlanChangeView,
  BillingPlanChangePreview,
} from "@mocha-house/contracts";
import {
  confirmAdminPlanChange,
  openAdminPlanChangePayment,
  previewAdminPlanChange,
} from "@/lib/internal-auth/admin-billing";

// SC3d-2 — the business's own plan change. Each call carries only OUR ids
// (a price to preview, the preview to confirm); the API re-checks
// everything, and charges only the exact previewed amount.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PlanChangeState =
  | { kind: "idle" }
  | { kind: "preview"; preview: BillingPlanChangePreview }
  | { kind: "done"; planChange: AdminPlanChangeView }
  // previewId: the preview a refused confirmation was for; stalePreview: it
  // can never be confirmed (expired or the price moved) and is withdrawn.
  | { kind: "error"; message: string; previewId?: string; stalePreview?: boolean };

export async function previewPlanChangeAction(
  _previous: PlanChangeState,
  form: FormData,
): Promise<PlanChangeState> {
  const planPriceId = form.get("planPriceId");
  if (typeof planPriceId !== "string" || !UUID.test(planPriceId)) {
    return { kind: "error", message: "Choose a plan." };
  }
  const result = await previewAdminPlanChange(planPriceId);
  return result.outcome === "ok"
    ? { kind: "preview", preview: result.data }
    : { kind: "error", message: result.message };
}

export async function confirmPlanChangeAction(
  _previous: PlanChangeState,
  form: FormData,
): Promise<PlanChangeState> {
  const previewId = form.get("previewId");
  if (typeof previewId !== "string" || !UUID.test(previewId)) {
    return { kind: "error", message: "Choose the plan again." };
  }
  const result = await confirmAdminPlanChange(previewId);
  if (result.outcome === "refused") {
    return {
      kind: "error",
      message: result.message,
      previewId,
      stalePreview:
        result.code === "BILLING_PLAN_CHANGE_PREVIEW_EXPIRED" ||
        result.code === "BILLING_PLAN_CHANGE_PREVIEW_CHANGED",
    };
  }
  revalidatePath("/admin/billing");
  return { kind: "done", planChange: result.data.planChange };
}

// Used with useActionState; the previous state is not needed.
export async function payPlanChangeAction(): Promise<{ message: string | null }> {
  const result = await openAdminPlanChangePayment();
  if (result.outcome === "refused") return { message: result.message };
  redirect(result.url);
}
