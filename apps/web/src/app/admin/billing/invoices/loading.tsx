import { AdminPage } from "@/components/admin/AdminPage";
import { AdminLoading } from "@/components/admin/states";

// SC3e-1 — shown while the billing history loads.
export default function Loading() {
  return (
    <AdminPage>
      <AdminLoading label="Loading your billing history…" />
    </AdminPage>
  );
}
