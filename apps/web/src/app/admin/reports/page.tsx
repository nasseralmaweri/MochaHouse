import { redirect } from "next/navigation";

// Reports (Milestone 9A) has exactly one report so far. `/admin/reports`
// is not its own dashboard — it just sends the viewer straight to it.
// Authorization is enforced by the destination page, not here.
export default function AdminReportsIndexPage() {
  redirect("/admin/reports/orders");
}
