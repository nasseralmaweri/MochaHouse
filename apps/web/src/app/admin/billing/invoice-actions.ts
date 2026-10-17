"use server";

import { redirect } from "next/navigation";
import { openAdminInvoiceDocument } from "@/lib/internal-auth/admin-billing";

// SC3e-1 — open one invoice's document (the provider's page or PDF). Only
// OUR invoice id and the kind are sent; the API checks the invoice is this
// business's and resolves the link for this request only.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Used with useActionState.
export async function openInvoiceDocumentAction(
  _previous: { message: string | null },
  form: FormData,
): Promise<{ message: string | null }> {
  const invoiceId = form.get("invoiceId");
  const kind = form.get("kind");
  if (typeof invoiceId !== "string" || !UUID.test(invoiceId) || (kind !== "invoice" && kind !== "pdf")) {
    return { message: "Refresh this page and try again." };
  }
  const result = await openAdminInvoiceDocument(invoiceId, kind);
  if (result.outcome === "refused") return { message: result.message };
  redirect(result.url);
}
