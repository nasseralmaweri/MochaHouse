import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminAuditEvents } from "@/lib/internal-auth/admin-audit";
import { can } from "@/lib/admin/capabilities";
import {
  buildAuditQuery,
  hasActiveAuditFilters,
  normalizeAuditFilters,
} from "@/lib/admin/audit-log";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { AuditLogBrowser } from "@/components/admin/AuditLogBrowser";

// Administration → Activity log (Milestone 5F). Read-only. `audit.view` is
// CORPORATE-only and the API enforces it; the check here just keeps the
// page out of the way for anyone who can't use it. Filters and the cursor
// live entirely in the URL query string, so the view is refresh-safe and
// linkable.
export default async function AdminActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string | string[];
    from?: string | string[];
    to?: string | string[];
    actor?: string | string[];
    cursor?: string | string[];
  }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Activity log"
      description="Review important administrative changes to Admin access and permissions."
      breadcrumbs={[
        { label: "Administration", href: "/admin/administration" },
        { label: "Activity log" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "audit.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const params = await searchParams;
  const filters = normalizeAuditFilters(params);
  const cursor = Array.isArray(params.cursor)
    ? params.cursor[0]
    : params.cursor;
  const viewingOlder = Boolean(cursor);

  const result = await getAdminAuditEvents(buildAuditQuery(filters, cursor));

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
  if (result.outcome === "invalid") {
    // A hand-edited or stale link with a bad filter/cursor. Send the viewer
    // back to the unfiltered newest view rather than showing an error.
    redirect("/admin/administration/audit");
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load the activity log just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <AuditLogBrowser
        events={result.data.events}
        nextCursor={result.data.nextCursor}
        filters={filters}
        viewingOlder={viewingOlder}
        filtersActive={hasActiveAuditFilters(filters)}
      />
    </AdminPage>
  );
}
