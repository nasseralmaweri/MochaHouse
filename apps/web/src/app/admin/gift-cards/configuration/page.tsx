import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getGiftCardConfiguration } from "@/lib/internal-auth/admin-gift-cards";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { GiftCardTabs } from "@/components/admin/GiftCardTabs";
import { GiftCardConfigurationForm } from "@/components/admin/GiftCardConfigurationForm";

// Admin → Gift Cards → Purchasing configuration (Milestone 7F). Preset
// purchase amounts and whether customers may later enter a custom amount.
// Persisted for the future customer-purchasing slice — nothing in 7F
// consumes it. `giftcards.configure` is CORPORATE-only and the API
// enforces it.
export default async function AdminGiftCardConfigurationPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Gift card purchasing"
      description="Preset amounts and the custom-amount option for future customer gift-card purchases."
      breadcrumbs={[
        { label: "Gift Cards", href: "/admin/gift-cards" },
        { label: "Purchasing configuration" },
      ]}
    />
  );

  if (!can(caps, "giftcards.configure")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getGiftCardConfiguration();
  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }

  return (
    <AdminPage>
      {header}
      <GiftCardTabs
        active="configuration"
        canViewOrManage={
          can(caps, "giftcards.view") || can(caps, "giftcards.manage")
        }
        canConfigure
      />
      {result.outcome === "forbidden" ? (
        <AdminForbidden />
      ) : result.outcome === "error" ? (
        <AdminErrorState description="Couldn't load the gift-card configuration just now. Please try again." />
      ) : (
        <GiftCardConfigurationForm configuration={result.data} />
      )}
    </AdminPage>
  );
}
