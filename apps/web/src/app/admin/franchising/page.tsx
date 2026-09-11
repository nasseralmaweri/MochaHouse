import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminFranchiseInquiries } from "@/lib/internal-auth/admin-franchising";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { FranchisingInquiriesBrowser } from "@/components/admin/FranchisingInquiriesBrowser";

// Admin → Franchising (Milestone 8D). A single flat area — no sub-tabs.
// `franchising.view` is CORPORATE-only and the API enforces it; the check
// here just keeps the page out of the way for anyone who can't use it.
export default async function AdminFranchisingPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Franchising"
      description="Franchise inquiries submitted from the public site. Open an inquiry to see its details, change its status, and add internal notes."
      breadcrumbs={[{ label: "Franchising" }]}
    />
  );

  if (!can(caps, "franchising.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminFranchiseInquiries({});

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
        <AdminErrorState description="Couldn't load franchise inquiries just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <FranchisingInquiriesBrowser
        initial={{
          inquiries: result.data.inquiries,
          nextCursor: result.data.nextCursor,
        }}
      />
    </AdminPage>
  );
}
