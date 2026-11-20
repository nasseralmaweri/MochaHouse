import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { getAdminLocationTax } from "@/lib/internal-auth/admin-tax";
import {
  JURISDICTION_LABELS,
  taxPageNote,
  classNameOf,
  ratePercentLabel,
} from "@/lib/admin/tax";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { LocationTaxEditor } from "@/components/admin/LocationTaxEditor";
import { Card } from "@/components/Card";
import type { AdminTaxClass, AdminTaxVersion } from "@mocha-house/contracts";

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";

function VersionSummary({
  version,
  classes,
}: {
  version: AdminTaxVersion;
  classes: AdminTaxClass[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-secondary">
        Version {version.version}
        {version.confirmedAt
          ? ` · confirmed ${when(version.confirmedAt)}${version.confirmedByName ? ` by ${version.confirmedByName}` : ""}`
          : ""}
        {version.supersededAt ? ` · replaced ${when(version.supersededAt)}` : ""}
      </p>
      {version.components.length === 0 ? (
        <p className="text-sm text-text-primary">No taxes at this location.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-text-primary">
          {version.components.map((component) => (
            <li key={component.id}>
              <span className="font-medium">{component.name}</span> (
              {JURISDICTION_LABELS[component.jurisdiction]}) ·{" "}
              {ratePercentLabel(component.ratePpm)} ·{" "}
              {component.taxClassIds
                .map((id) => classNameOf(classes, id))
                .join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// V1 Sales Tax PR 1 — one location's tax settings: the confirmed version,
// the draft editor and earlier versions. Authorized administrator only; the
// API re-checks every read and change.
export default async function AdminLocationTaxPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;
  const session = await getInternalSession();
  if (!session) redirect("/internal/sign-in");
  const breadcrumbs = [
    { label: "Sales tax", href: "/admin/tax" },
    { label: "Location" },
  ];
  if (!can(session.authorization.capabilities, "tax.manage")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Location sales tax" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminLocationTax(locationId);
  if (result.outcome === "unauthenticated") redirect("/internal/sign-in");
  if (result.outcome !== "success") {
    return (
      <AdminPage>
        <AdminPageHeader title="Location sales tax" breadcrumbs={breadcrumbs} />
        {result.outcome === "forbidden" ? (
          <AdminForbidden description="Only your business's authorized administrator can manage sales tax." />
        ) : result.outcome === "not-found" ? (
          <AdminNotFound
            title="Location not found"
            description="This location doesn't exist, or it has been removed."
            backHref="/admin/tax"
            backLabel="Back to sales tax"
          />
        ) : (
          <AdminErrorState description="We couldn't load this location's tax settings just now. Please try again." />
        )}
      </AdminPage>
    );
  }
  const data = result.data;

  return (
    <AdminPage>
      <AdminPageHeader
        title={`${data.location.name} sales tax`}
        breadcrumbs={[
          { label: "Sales tax", href: "/admin/tax" },
          { label: data.location.name },
        ]}
      />
      <p
        role="status"
        className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary"
      >
        {taxPageNote(data.taxCollectionEnabled)}
      </p>

      <AdminSection title="Confirmed settings">
        <Card>
          {data.confirmed ? (
            <VersionSummary version={data.confirmed} classes={data.classes} />
          ) : (
            <p className="text-sm text-text-secondary">
              Nothing confirmed yet for this location.
            </p>
          )}
        </Card>
      </AdminSection>

      <AdminSection
        title={data.confirmed ? "Make a change" : "Set up taxes"}
        description="Saving creates a draft. The confirmed settings stay as they are until you confirm the draft."
      >
        <LocationTaxEditor
          key={`${data.draft?.id ?? "none"}-${data.confirmed?.id ?? "none"}`}
          data={data}
        />
      </AdminSection>

      {data.history.length > 0 ? (
        <AdminSection title="Earlier versions">
          <Card className="flex flex-col gap-4 divide-y divide-border-default">
            {data.history.map((version) => (
              <div key={version.id} className="pt-4 first:pt-0">
                <VersionSummary version={version} classes={data.classes} />
              </div>
            ))}
          </Card>
        </AdminSection>
      ) : null}
    </AdminPage>
  );
}
