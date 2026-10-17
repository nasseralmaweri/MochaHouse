"use client";

import { useActionState } from "react";
import { openInvoiceDocumentAction } from "./invoice-actions";

const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border-default px-3 text-sm font-semibold text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-wait aria-disabled:opacity-70";

const INITIAL: { message: string | null } = { message: null };

// SC3e-1 — the provider's own invoice page (with its receipt once paid) or
// its PDF, for one invoice. The link is fetched on press, never kept here. A
// refusal is announced (alert) while focus stays on the pressed button.
export function InvoiceDocumentButtons({ invoiceId, label }: { invoiceId: string; label: string }) {
  const [state, formAction, pending] = useActionState(openInvoiceDocumentAction, INITIAL);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="flex flex-col items-start gap-2"
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="kind"
          value="invoice"
          aria-disabled={pending}
          aria-label={`View invoice, ${label}`}
          className={SECONDARY}
        >
          View invoice
        </button>
        <button
          type="submit"
          name="kind"
          value="pdf"
          aria-disabled={pending}
          aria-label={`Download PDF, ${label}`}
          className={SECONDARY}
        >
          Download PDF
        </button>
      </div>
      <p role="status" className="sr-only">
        {pending ? "Opening the document…" : ""}
      </p>
      {state.message ? (
        <p role="alert" className="text-sm text-status-error">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
