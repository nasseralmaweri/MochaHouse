import Link from "next/link";
import type { AdminJobApplicationDetail } from "@mocha-house/contracts";
import {
  applicantName,
  applicationActivityLine,
  applicationStatusLabel,
  applicationStatusTone,
  formatApplicantDate,
  workAuthorizedLabel,
} from "@/lib/admin/applicants";
import { jobStatusLabel } from "@/lib/admin/careers";
import { Card } from "@/components/Card";
import { AdminSection } from "./AdminPage";
import { StatusBadge } from "./StatusBadge";
import { ApplicationStatusControl } from "./ApplicationStatusControl";
import { ApplicationNotesPanel } from "./ApplicationNotesPanel";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right text-text-primary">{value}</span>
    </div>
  );
}

// Admin → Careers → Applicants → detail (Milestone 8C). Read-only
// presentation of one application, plus the status control and the
// append-only internal notes when the viewer holds `applicants.manage`.
// Candidate PII is shown here because the page is CORPORATE-only and the API
// enforces it.
export function ApplicationDetail({
  detail,
  canManage,
}: {
  detail: AdminJobApplicationDetail;
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      <AdminSection title="Applicant">
        <Card className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-base font-semibold text-text-primary">
              {applicantName(detail.firstName, detail.lastName)}
            </span>
            <StatusBadge
              label={applicationStatusLabel(detail.status)}
              tone={applicationStatusTone(detail.status)}
            />
          </div>
          <Row label="Email" value={detail.email} />
          <Row label="Phone" value={detail.phone} />
          <Row label="Location" value={detail.location} />
          <Row label="Applied" value={formatApplicantDate(detail.createdAt)} />
        </Card>
      </AdminSection>

      <AdminSection title="Position">
        <Card className="flex flex-col gap-2">
          <Row label="Applied for" value={detail.jobTitleSnapshot} />
          <Row
            label="Job opening"
            value={
              <Link
                href={`/admin/careers/${detail.jobOpeningId}`}
                className="underline underline-offset-2"
              >
                {detail.jobStatus
                  ? `Open job (${jobStatusLabel(detail.jobStatus)})`
                  : "Open job"}
              </Link>
            }
          />
          <p className="text-xs text-text-muted">
            The title above is a snapshot taken when the application was
            submitted; it does not change if the job is later edited or
            archived.
          </p>
        </Card>
      </AdminSection>

      <AdminSection title="Answers">
        <Card className="flex flex-col gap-3">
          <Row
            label="Work authorization"
            value={workAuthorizedLabel(detail.workAuthorized)}
          />
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">Availability</span>
            <p className="whitespace-pre-wrap text-text-primary">
              {detail.availability}
            </p>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">
              Why they&apos;re interested
            </span>
            <p className="whitespace-pre-wrap text-text-primary">
              {detail.message}
            </p>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">
              Resume / LinkedIn / Portfolio link
            </span>
            {detail.resumeUrl ? (
              <a
                href={detail.resumeUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="break-all text-text-primary underline underline-offset-2"
              >
                {detail.resumeUrl}
              </a>
            ) : (
              <span className="text-text-muted">Not provided</span>
            )}
          </div>
        </Card>
      </AdminSection>

      <AdminSection
        title="Status"
        description="Any status can move to any other status. Every change is recorded."
      >
        {canManage ? (
          <ApplicationStatusControl
            applicationId={detail.id}
            status={detail.status}
          />
        ) : (
          <Card tone="subtle" className="text-sm text-text-secondary">
            Currently {applicationStatusLabel(detail.status)}. You don&apos;t
            have permission to change it.
          </Card>
        )}
      </AdminSection>

      <AdminSection
        title="Internal notes"
        description="Staff-only. Append-only in this release."
      >
        <ApplicationNotesPanel
          applicationId={detail.id}
          initialNotes={detail.notes}
          canManage={canManage}
        />
      </AdminSection>

      <AdminSection title="Activity">
        {detail.activity.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No recorded activity for this application yet.
          </Card>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm text-text-secondary">
            {detail.activity.map((item) => (
              <li key={item.id}>{applicationActivityLine(item)}</li>
            ))}
          </ul>
        )}
      </AdminSection>

      <p className="text-xs text-text-muted">
        <Link
          href="/admin/careers/applicants"
          className="underline underline-offset-2"
        >
          Back to all applicants
        </Link>
      </p>
    </div>
  );
}
