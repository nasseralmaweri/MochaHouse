import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminFranchiseInquiry } from "@/lib/internal-auth/admin-franchising";
import { can } from "@/lib/admin/capabilities";
import { prospectName } from "@/lib/admin/franchising";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { FranchiseInquiryDetail } from "@/components/admin/FranchiseInquiryDetail";

// Admin → Franchising → detail (Milestone 8D). `franchising.view` gates the
// page; the status control and "add note" form inside gate separately on
// `franchising.manage`. The API re-checks both, and both keys are
// CORPORATE-only.
export default async function AdminFranchiseInquiryDetailPage({
  params,
}: {
  params: Promise<{ inquiryId: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { inquiryId } = await params;
  const caps = session.authorization.capabilities;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Franchising", href: "/admin/franchising" },
        { label: title },
      ]}
    />
  );

  if (!can(caps, "franchising.view")) {
    return (
      <AdminPage>
        {header("Inquiry")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminFranchiseInquiry(inquiryId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Inquiry")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Inquiry")}
        <AdminNotFound
          description="This inquiry doesn't exist."
          backHref="/admin/franchising"
          backLabel="Back to all inquiries"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header("Inquiry")}
        <AdminErrorState description="Couldn't load this inquiry just now. Please try again." />
      </AdminPage>
    );
  }

  const title = prospectName(result.data.firstName, result.data.lastName);

  return (
    <AdminPage>
      {header(title)}
      <FranchiseInquiryDetail
        detail={result.data}
        canManage={can(caps, "franchising.manage")}
      />
    </AdminPage>
  );
}
