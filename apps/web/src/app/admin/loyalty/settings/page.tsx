import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getLoyaltySettings } from "@/lib/internal-auth/admin-loyalty";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { LoyaltyTabs } from "@/components/admin/LoyaltyTabs";
import { LoyaltySettingsForm } from "@/components/admin/LoyaltySettingsForm";

// Admin → Loyalty → Settings (Milestone 7B). The standard company-wide
// Mocha Bean earning rate. `loyalty.configure` is CORPORATE-only and the
// API enforces it; the check here just keeps the page out of the way.
export default async function AdminLoyaltySettingsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Loyalty settings"
      description="The standard company-wide Mocha Bean earning rate."
      breadcrumbs={[
        { label: "Loyalty", href: "/admin/loyalty" },
        { label: "Settings" },
      ]}
    />
  );

  if (!can(caps, "loyalty.configure")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getLoyaltySettings();
  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }

  return (
    <AdminPage>
      {header}
      <LoyaltyTabs
        active="settings"
        canView={can(caps, "loyalty.view")}
        canConfigure
      />
      {result.outcome === "forbidden" ? (
        <AdminForbidden />
      ) : result.outcome === "error" ? (
        <AdminErrorState description="Couldn't load the loyalty settings just now. Please try again." />
      ) : (
        <LoyaltySettingsForm settings={result.data} />
      )}
    </AdminPage>
  );
}
