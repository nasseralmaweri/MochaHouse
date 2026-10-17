import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { getAdminInvoices } from "@/lib/internal-auth/admin-billing";
import { BILLING_HISTORY_MESSAGES, pageCursor } from "@/lib/admin/billing-history";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminEmptyState, AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";
import { InvoiceList } from "@/components/billing/InvoiceList";
import { InvoiceDocumentButtons } from "../InvoiceDocumentButtons";

const LINK =
  "inline-flex min-h-11 items-center text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

// SC3e-1 — the business's CENTERIVO billing history: invoices (newest first,
// 20 a page), amounts, refunds and credits as the billing provider reports
// them, and each invoice's own page or PDF. Payments from the business's
// customers are never shown here.
export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await getInternalSession();
  if (!session) redirect("/internal/sign-in");
  const header = (
    <AdminPageHeader
      title="Billing history"
      description="Invoices for your CENTERIVO subscription. Payments from your customers are not shown here."
      breadcrumbs={[{ label: "Billing", href: "/admin/billing" }, { label: "Billing history" }]}
    />
  );
  if (!can(session.authorization.capabilities, "billing.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  const params = await searchParams;
  const cursor = pageCursor(params.cursor);
  if (params.cursor !== undefined && cursor === null) redirect("/admin/billing/invoices");
  const result = await getAdminInvoices(cursor);
  if (result.outcome === "unauthenticated") redirect("/internal/sign-in");
  if (result.outcome === "invalid-page") {
    return (
      <AdminPage>
        {header}
        <Card className="flex flex-col items-start gap-2">
          <p role="status" className="text-sm text-text-primary">
            {BILLING_HISTORY_MESSAGES.invalidPage}
          </p>
          <Link href="/admin/billing/invoices" className={LINK}>
            Show the newest invoices
          </Link>
        </Card>
      </AdminPage>
    );
  }
  if (result.outcome !== "success") {
    return (
      <AdminPage>
        {header}
        {result.outcome === "forbidden" ? (
          <AdminForbidden />
        ) : (
          <>
            <AdminErrorState
              title="Billing history unavailable"
              description={BILLING_HISTORY_MESSAGES.unavailable}
            />
            <Link href={cursor ? `/admin/billing/invoices?cursor=${cursor}` : "/admin/billing/invoices"} className={LINK}>
              Try again
            </Link>
          </>
        )}
      </AdminPage>
    );
  }
  const { invoices, nextCursor } = result.data;

  return (
    <AdminPage>
      {header}
      {invoices.length === 0 ? (
        <AdminEmptyState
          title={cursor ? "No older invoices" : "No invoices yet"}
          description={cursor ? undefined : BILLING_HISTORY_MESSAGES.empty}
          action={
            cursor ? (
              <Link href="/admin/billing/invoices" className={LINK}>
                Show the newest invoices
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Card className="flex flex-col gap-4">
          <p className="text-xs text-text-secondary">
            Amounts and documents come from our payment provider. Once an invoice is paid, its
            receipt is on the invoice page.
          </p>
          <InvoiceList
            invoices={invoices}
            actions={(invoice, label) => <InvoiceDocumentButtons invoiceId={invoice.id} label={label} />}
          />
          <nav aria-label="Billing history pages" className="flex flex-wrap gap-4">
            {cursor ? (
              <Link href="/admin/billing/invoices" className={LINK}>
                Newest invoices
              </Link>
            ) : null}
            {nextCursor ? (
              <Link href={`/admin/billing/invoices?cursor=${nextCursor}`} className={LINK}>
                Older invoices
              </Link>
            ) : null}
          </nav>
        </Card>
      )}
    </AdminPage>
  );
}
