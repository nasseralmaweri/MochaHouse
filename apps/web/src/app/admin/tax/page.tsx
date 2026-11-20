import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { getAdminTaxSettings } from "@/lib/internal-auth/admin-tax";
import {
  TAX_PAGE_NOTE,
  locationTaxStateLabel,
  ratePercentLabel,
} from "@/lib/admin/tax";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { ButtonLink } from "@/components/admin/Button";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { TaxClassesManager } from "@/components/admin/TaxClassesManager";
import { TaxClassificationEditor } from "@/components/admin/TaxClassificationEditor";
import { Card } from "@/components/Card";

// V1 Sales Tax PR 1 — Admin > Sales tax: tax classes, how each category
// (and optionally product) is classified, and each location's tax settings.
// The business's authorized administrator only; the API re-checks.
export default async function AdminTaxPage() {
  const session = await getInternalSession();
  if (!session) redirect("/internal/sign-in");
  const header = (
    <AdminPageHeader
      title="Sales tax"
      description="Tax classes, how your menu is classified, and the tax rates at each location."
    />
  );
  if (!can(session.authorization.capabilities, "tax.manage")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminTaxSettings();
  if (result.outcome === "unauthenticated") redirect("/internal/sign-in");
  if (result.outcome !== "success") {
    return (
      <AdminPage>
        {header}
        {result.outcome === "forbidden" ? (
          <AdminForbidden description="Only your business's authorized administrator can manage sales tax." />
        ) : (
          <AdminErrorState description="We couldn't load your sales tax settings just now. Please try again." />
        )}
      </AdminPage>
    );
  }
  const settings = result.data;

  return (
    <AdminPage>
      {header}
      <p
        role="status"
        className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary"
      >
        {TAX_PAGE_NOTE}
      </p>

      <AdminSection
        title="Locations"
        description="Each location has its own tax rates. Changes are saved as a draft and only take effect once you confirm them; earlier versions are kept."
      >
        <Card className="flex flex-col divide-y divide-border-default">
          {settings.locations.length === 0 ? (
            <p className="text-sm text-text-secondary">No locations yet.</p>
          ) : (
            settings.locations.map((location) => {
              const state = locationTaxStateLabel(location);
              return (
                <div
                  key={location.id}
                  className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">
                        {location.name}
                      </span>
                      <StatusBadge label={state.label} tone={state.tone} />
                    </div>
                    {location.confirmedDefaultRatePpm !== null ? (
                      <span className="text-sm text-text-secondary">
                        Version {location.confirmedVersion} · Prepared Food{" "}
                        {ratePercentLabel(location.confirmedDefaultRatePpm)}
                      </span>
                    ) : null}
                  </div>
                  <ButtonLink
                    href={`/admin/tax/locations/${location.id}`}
                    className="w-full sm:w-auto"
                  >
                    {location.state === "NOT_SET" ? "Set up" : "View and edit"}
                  </ButtonLink>
                </div>
              );
            })
          )}
        </Card>
      </AdminSection>

      <AdminSection
        title="Menu classification"
        description={
          settings.unreviewedActiveCategories > 0
            ? `Confirm a tax class for each category. ${settings.unreviewedActiveCategories} active categor${settings.unreviewedActiveCategories === 1 ? "y needs" : "ies need"} review before any location's tax settings can be confirmed.`
            : "Every active category has a confirmed tax class. A product can use its own class instead of its category's."
        }
      >
        <TaxClassificationEditor
          classes={settings.classes}
          categories={settings.categories}
          products={settings.products}
        />
      </AdminSection>

      <AdminSection
        title="Tax classes"
        description="Group your menu by how it is taxed. Each location's taxes say which classes they apply to."
      >
        <TaxClassesManager classes={settings.classes} />
      </AdminSection>
    </AdminPage>
  );
}
