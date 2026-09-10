import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCustomerDetail } from "@/lib/internal-auth/admin-customers";
import { can } from "@/lib/admin/capabilities";
import { customerDisplayName } from "@/lib/admin/crm";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { CustomerDetail } from "@/components/admin/CustomerDetail";

// Admin → Customers → detail (Milestone 8A). Read-only aggregated CRM view.
// `customers.view` gates the page; the "add note" control inside gates
// separately on `customers.notes.manage`. The API re-checks both.
export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { customerId } = await params;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Customers", href: "/admin/customers" },
        { label: title },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "customers.view")) {
    return (
      <AdminPage>
        {header("Customer")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminCustomerDetail(customerId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Customer")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Customer")}
        <AdminNotFound
          description="This customer doesn't exist."
          backHref="/admin/customers"
          backLabel="Back to all customers"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header("Customer")}
        <AdminErrorState description="Couldn't load this customer just now. Please try again." />
      </AdminPage>
    );
  }

  const title = customerDisplayName(result.data.customer);

  return (
    <AdminPage>
      {header(title)}
      <CustomerDetail
        detail={result.data}
        canManageNotes={can(
          session.authorization.capabilities,
          "customers.notes.manage",
        )}
      />
    </AdminPage>
  );
}
