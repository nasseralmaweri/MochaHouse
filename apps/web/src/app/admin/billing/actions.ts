"use server";

import { redirect } from "next/navigation";
import {
  openAdminBillingCheckout,
  openAdminBillingRecovery,
} from "@/lib/internal-auth/admin-billing";

// SC3b/SC3c-2 — each sends the owner to the payment provider's secure hosted
// page. The request carries nothing: the API decides the business, price,
// trial, invoice and customer from its own records.
export interface SetUpPaymentState {
  message: string | null;
}

// Used with useActionState; the previous state is not needed.
// Set up payment, or restart an ended subscription (no trial).
export async function setUpPaymentAction(): Promise<SetUpPaymentState> {
  const result = await openAdminBillingCheckout();
  if (result.outcome === "refused") return { message: result.message };
  redirect(result.url);
}

// SC3c-2 — pay the outstanding invoice on the provider's hosted page.
export async function payInvoiceAction(): Promise<SetUpPaymentState> {
  const result = await openAdminBillingRecovery("invoice");
  if (result.outcome === "refused") return { message: result.message };
  redirect(result.url);
}

// SC3c-2 — the provider's Customer Portal (payment methods and invoices).
export async function openPortalAction(): Promise<SetUpPaymentState> {
  const result = await openAdminBillingRecovery("portal");
  if (result.outcome === "refused") return { message: result.message };
  redirect(result.url);
}
