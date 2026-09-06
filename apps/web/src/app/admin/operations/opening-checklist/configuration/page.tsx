"use client";

import { useAdminContext } from "@/components/admin/AdminContext";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { OpeningChecklistTemplateEditor } from "@/components/admin/OpeningChecklistTemplateEditor";

// Admin → Operations → Opening Checklist → Configuration (Milestone 6B-2).
// HQ management of the ONE corporate Opening Checklist template every
// location's daily checklist is created from. Deliberately separate from
// `/admin/operations/opening-checklist`, which is the per-store daily
// execution page.
//
// `operations.checklists.configure` gates the page. It is CORPORATE-only,
// so this capability is only ever present for HQ staff — the same check the
// API enforces on every route. There is no location context here.
export default function OpeningChecklistConfigurationPage() {
  const { can } = useAdminContext();

  const breadcrumbs = [
    { label: "Operations", href: "/admin/operations" },
    { label: "Opening Checklist" },
    { label: "Configuration" },
  ];

  if (!can("operations.checklists.configure")) {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Opening Checklist configuration"
          breadcrumbs={breadcrumbs}
        />
        <AdminForbidden
          title="You can't configure the checklist"
          description="Managing the corporate Opening Checklist is a head-office task. If you think you should have access, ask an administrator."
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Opening Checklist"
        description="The corporate standard every Mocha House location opens to."
        context={{ label: "All locations", kind: "corporate" }}
        breadcrumbs={breadcrumbs}
      />
      <OpeningChecklistTemplateEditor />
    </AdminPage>
  );
}
