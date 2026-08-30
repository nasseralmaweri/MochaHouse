"use client";

import { useEffect } from "react";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState } from "@/components/admin/states";

// Route-level error boundary for /admin (5xx / unexpected render or fetch
// errors). Recoverable — offers a retry via reset(). Distinct from the
// 403 (AdminForbidden) and 404 (not-found) states, which pages render
// inline.
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AdminPage>
      <AdminPageHeader title="Something went wrong" />
      <AdminErrorState
        description="We hit a problem loading this part of the Admin platform. Please try again."
        onRetry={reset}
      />
    </AdminPage>
  );
}
