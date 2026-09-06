"use client";

import type { ChecklistKind } from "@/lib/api-client";
import { useAdminContext } from "@/components/admin/AdminContext";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { ChecklistTemplateEditor } from "@/components/admin/ChecklistTemplateEditor";

// Shared HQ configuration page for the daily checklists (Milestone 6B-2
// Opening; 6D Closing). Separate from the per-store execution page.
//
// `operations.checklists.configure` gates the page — it is CORPORATE-only,
// so this capability is only ever present for HQ staff (the same check the
// API enforces on every route). There is no location context here.
const COPY: Record<
  ChecklistKind,
  { name: string; description: string }
> = {
  opening: {
    name: "Opening Checklist",
    description: "The corporate standard every Mocha House location opens to.",
  },
  closing: {
    name: "Closing Checklist",
    description: "The corporate standard every Mocha House location closes to.",
  },
};

export function ChecklistConfigurationPage({
  checklist,
}: {
  checklist: ChecklistKind;
}) {
  const { can } = useAdminContext();
  const { name, description } = COPY[checklist];

  const breadcrumbs = [
    { label: "Operations", href: "/admin/operations" },
    { label: name },
    { label: "Configuration" },
  ];

  if (!can("operations.checklists.configure")) {
    return (
      <AdminPage>
        <AdminPageHeader
          title={`${name} configuration`}
          breadcrumbs={breadcrumbs}
        />
        <AdminForbidden
          title="You can't configure this checklist"
          description="Managing a corporate checklist is a head-office task. If you think you should have access, ask an administrator."
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title={name}
        description={description}
        context={{ label: "All locations", kind: "corporate" }}
        breadcrumbs={breadcrumbs}
      />
      <ChecklistTemplateEditor checklist={checklist} />
    </AdminPage>
  );
}
