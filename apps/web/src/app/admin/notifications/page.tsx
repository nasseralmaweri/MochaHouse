import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminNotificationHealth } from "@/lib/internal-auth/admin-notification-health";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { NotificationHealthView } from "@/components/admin/NotificationHealthView";

// Admin → Notifications (R1 / S4c). A read-only health summary of the active
// business's notification delivery. `notifications.routing.view` is
// CORPORATE-only and the API enforces it and the business; the check here only
// keeps the page out of the way for anyone who can't use it.
export default async function AdminNotificationsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Notifications"
      description="Whether order and business notifications are being sent, retried or given up on. Read-only."
      breadcrumbs={[{ label: "Notifications" }]}
    />
  );

  if (!can(session.authorization.capabilities, "notifications.routing.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminNotificationHealth();
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
        <AdminErrorState description="Couldn't load the notification summary just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <NotificationHealthView health={result.data} />
    </AdminPage>
  );
}
