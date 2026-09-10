import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCustomers } from "@/lib/internal-auth/admin-customers";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { CustomersBrowser } from "@/components/admin/CustomersBrowser";

// Admin → Customers (Milestone 8A). The HQ CRM directory over authoritative
// customer data. `customers.view` is CORPORATE-only and the API enforces
// it; the check here just keeps the page out of the way for anyone who
// can't use it.
export default async function AdminCustomersPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Customers"
      description="Search the customer directory and open a customer to see their profile, orders, Mocha Beans, gift cards and internal notes."
      breadcrumbs={[{ label: "Customers" }]}
    />
  );

  if (!can(session.authorization.capabilities, "customers.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminCustomers({});

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "error" || result.outcome === "not-found") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load the customer directory just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <CustomersBrowser
        initial={{
          customers: result.data.customers,
          nextCursor: result.data.nextCursor,
        }}
      />
    </AdminPage>
  );
}
