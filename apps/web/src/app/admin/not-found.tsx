import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminNotFound } from "@/components/admin/states";

// Route-level not-found for /admin. Resource-not-found semantics — never a
// sign-in prompt, never a generic error.
export default function AdminNotFoundPage() {
  return (
    <AdminPage>
      <AdminPageHeader title="Not found" />
      <AdminNotFound />
    </AdminPage>
  );
}
