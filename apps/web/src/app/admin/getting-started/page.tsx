import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminGettingStarted } from "@/lib/internal-auth/admin-locations";
import { isCorporateFor } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { GettingStartedChecklist } from "@/components/admin/GettingStartedChecklist";

// SC4d — Getting started: the business's setup checklist, computed by the
// API from real data on every visit. Business-wide, so corporate
// `locations.view` only (the API re-checks).
export default async function GettingStartedPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Getting started"
      description="Set up your business, one step at a time."
    />
  );

  if (!isCorporateFor(session.authorization.capabilities, "locations.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden description="Business setup is managed by your business's owner or administrators." />
      </AdminPage>
    );
  }

  const checklist = await getAdminGettingStarted();
  if (!checklist) {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load your setup steps just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <GettingStartedChecklist checklist={checklist} />
    </AdminPage>
  );
}
