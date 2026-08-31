import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminPlatformStatus } from "@/lib/internal-auth/admin-platform";
import { can } from "@/lib/admin/capabilities";
import { platformStatusSections } from "@/lib/admin/platform-status";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";

// Administration → Platform Status (Milestone 5G). Read-only, informational.
// `platform.view` is CORPORATE-only and the API enforces it; the check here
// just keeps the page out of the way for anyone who can't use it. The API
// returns only plain-language labels and safe aggregate counts — this page
// never sees raw configuration.
export default async function AdminPlatformStatusPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Platform status"
      description="How the Mocha House platform is currently configured."
      breadcrumbs={[
        { label: "Administration", href: "/admin/administration" },
        { label: "Platform status" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "platform.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminPlatformStatus();

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
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load platform status just now. Please try again." />
      </AdminPage>
    );
  }

  const sections = platformStatusSections(result.data);

  return (
    <AdminPage>
      {header}
      {sections.map((section) => (
        <AdminSection key={section.title} title={section.title}>
          <Card className="flex flex-col gap-3">
            {section.rows.map((row) => (
              <div key={row.label} className="flex flex-col gap-0.5">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {row.label}
                </span>
                <span className="text-base text-text-primary">{row.value}</span>
              </div>
            ))}
          </Card>
        </AdminSection>
      ))}
    </AdminPage>
  );
}
