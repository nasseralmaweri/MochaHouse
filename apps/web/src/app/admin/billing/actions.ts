"use server";

import { redirect } from "next/navigation";
import { openAdminBillingCheckout } from "@/lib/internal-auth/admin-billing";

// SC3b — open (or reuse) the business's hosted payment-setup page and send
// the owner there. The request carries nothing: the API decides the
// business, price and trial from its own records.
export interface SetUpPaymentState {
  message: string | null;
}

export async function setUpPaymentAction(
  _previous: SetUpPaymentState,
): Promise<SetUpPaymentState> {
  const result = await openAdminBillingCheckout();
  if (result.outcome === "refused") return { message: result.message };
  redirect(result.url);
}
