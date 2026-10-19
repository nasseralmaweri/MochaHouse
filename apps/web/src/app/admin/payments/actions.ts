"use server";

import { redirect } from "next/navigation";
import { openPaymentOnboarding } from "@/lib/internal-auth/admin-payments";

// ESP-04 M1 — sends the owner to Stripe's hosted onboarding for the
// restaurant's own account. The request carries nothing: the API decides the
// business, the account and where Stripe returns to.
export interface ConnectPaymentsState {
  message: string | null;
}

// Used with useActionState; the previous state is not needed.
export async function connectPaymentsAction(): Promise<ConnectPaymentsState> {
  const result = await openPaymentOnboarding();
  if (result.outcome === "refused") return { message: result.message };
  redirect(result.url);
}
