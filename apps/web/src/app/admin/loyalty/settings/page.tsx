import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getLoyaltyPointsLabel,
  getLoyaltySettings,
} from "@/lib/internal-auth/admin-loyalty";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { LoyaltyTabs } from "@/components/admin/LoyaltyTabs";
import { LoyaltySettingsForm } from "@/components/admin/LoyaltySettingsForm";
import { PointsLabelForm } from "@/components/admin/PointsLabelForm";
import { AdminSection } from "@/components/admin/AdminPage";
import { adminPointsLabel } from "@/lib/internal-auth/points-label";
import { singularPoints } from "@/lib/loyalty-label";

// Admin → Loyalty → Settings (Milestone 7B). The standard company-wide
// Mocha Bean earning rate. `loyalty.configure` is CORPORATE-only and the
// API enforces it; the check here just keeps the page out of the way.
export default async function AdminLoyaltySettingsPage() {
  const pointsLabel = await adminPointsLabel();
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Loyalty settings"
      description={`The standard company-wide ${singularPoints(pointsLabel)} earning rate.`}
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

  const [result, label] = await Promise.all([
    getLoyaltySettings(),
    getLoyaltyPointsLabel(),
  ]);
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
      {label.outcome === "success" ? (
        <AdminSection title="Points name">
          <PointsLabelForm settings={label.data} />
        </AdminSection>
      ) : null}
    </AdminPage>
  );
}
