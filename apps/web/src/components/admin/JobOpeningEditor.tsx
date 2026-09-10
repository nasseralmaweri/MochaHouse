"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  AdminJobOpening,
  AdminJobOpeningOptions,
  JobEmploymentType,
} from "@mocha-house/contracts";
import {
  jobOpeningActionFromBrowser,
  updateJobOpeningFromBrowser,
} from "@/lib/api-client";
import {
  EMPLOYMENT_TYPE_OPTIONS,
  employmentTypeLabel,
  formatJobDate,
  jobLocationLabel,
  jobStatusLabel,
  jobStatusTone,
} from "@/lib/admin/careers";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

export function JobOpeningEditor({
  initial,
  options,
  canManage,
}: {
  initial: AdminJobOpening;
  options: AdminJobOpeningOptions | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const archived = job.status === "ARCHIVED";
  const [title, setTitle] = useState(job.title);
  const [employmentType, setEmploymentType] = useState<JobEmploymentType>(
    job.employmentType,
  );
  const [locationId, setLocationId] = useState(job.location?.id ?? "");
  const [summary, setSummary] = useState(job.summary);
  const [description, setDescription] = useState(job.description);
  const [responsibilities, setResponsibilities] = useState(job.responsibilities);
  const [qualifications, setQualifications] = useState(job.qualifications);

  function applyResult(
    result: Awaited<ReturnType<typeof updateJobOpeningFromBrowser>>,
  ) {
    if (result.outcome === "success") {
      setJob(result.job);
      setError(null);
      router.refresh();
      return;
    }
    setError(
      "message" in result
        ? result.message
        : result.outcome === "forbidden"
          ? "You no longer have permission to manage job openings."
          : "Job opening not found.",
    );
  }

  async function saveFields(event: React.FormEvent) {
    event.preventDefault();
    setPending("save");
    applyResult(
      await updateJobOpeningFromBrowser(job.id, {
        title: title.trim(),
        employmentType,
        locationId: locationId === "" ? null : locationId,
        summary: summary.trim(),
        description: description.trim(),
        responsibilities: responsibilities.trim(),
        qualifications: qualifications.trim(),
      }),
    );
    setPending(null);
  }

  async function runAction(action: "publish" | "unpublish" | "archive") {
    setPending(action);
    applyResult(await jobOpeningActionFromBrowser(job.id, action));
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-base font-semibold text-text-primary">
            {job.title}
          </span>
          <StatusBadge
            label={jobStatusLabel(job.status)}
            tone={jobStatusTone(job.status)}
          />
        </div>
        <p className="text-sm text-text-secondary">
          {jobLocationLabel(job.location)} ·{" "}
          {employmentTypeLabel(job.employmentType)}
          {" · "}
          {job.publishedAt
            ? `first published ${formatJobDate(job.publishedAt)}`
            : "never published"}
        </p>

        {canManage ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {job.status === "DRAFT" ? (
              <Button
                onClick={() => runAction("publish")}
                disabled={pending !== null}
              >
                {pending === "publish" ? "Publishing…" : "Publish"}
              </Button>
            ) : null}
            {job.status === "PUBLISHED" ? (
              <Button
                variant="secondary"
                onClick={() => runAction("unpublish")}
                disabled={pending !== null}
              >
                {pending === "unpublish" ? "Unpublishing…" : "Unpublish"}
              </Button>
            ) : null}
            {!archived ? (
              <Button
                variant="secondary"
                onClick={() => runAction("archive")}
                disabled={pending !== null}
              >
                {pending === "archive" ? "Archiving…" : "Archive"}
              </Button>
            ) : (
              <span className="text-sm text-text-secondary">
                This job opening is archived and can no longer be changed.
              </span>
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-status-warning">
            {error}
          </p>
        ) : null}
      </Card>

      {canManage && !archived ? (
        <Card>
          <form onSubmit={saveFields} className="flex flex-col gap-3">
            <FormField label="Title" htmlFor="edit-title">
              <input
                id="edit-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={ADMIN_FIELD_CLASS}
              />
            </FormField>
            <FormField label="Employment type" htmlFor="edit-type">
              <select
                id="edit-type"
                value={employmentType}
                onChange={(e) =>
                  setEmploymentType(e.target.value as JobEmploymentType)
                }
                className={ADMIN_FIELD_CLASS}
              >
                {EMPLOYMENT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Location" htmlFor="edit-location">
              <select
                id="edit-location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className={ADMIN_FIELD_CLASS}
              >
                <option value="">Corporate / HQ</option>
                {(options?.locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Short summary" htmlFor="edit-summary">
              <input
                id="edit-summary"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                className={ADMIN_FIELD_CLASS}
              />
            </FormField>
            <FormField label="Description" htmlFor="edit-desc">
              <textarea
                id="edit-desc"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className={`${ADMIN_FIELD_CLASS} resize-y`}
              />
            </FormField>
            <FormField label="Responsibilities" htmlFor="edit-resp">
              <textarea
                id="edit-resp"
                rows={3}
                value={responsibilities}
                onChange={(e) => setResponsibilities(e.target.value)}
                className={`${ADMIN_FIELD_CLASS} resize-y`}
              />
            </FormField>
            <FormField label="Qualifications" htmlFor="edit-qual">
              <textarea
                id="edit-qual"
                rows={3}
                value={qualifications}
                onChange={(e) => setQualifications(e.target.value)}
                className={`${ADMIN_FIELD_CLASS} resize-y`}
              />
            </FormField>
            <Button
              type="submit"
              disabled={pending !== null}
              className="self-start"
            >
              {pending === "save" ? "Saving…" : "Save changes"}
            </Button>
          </form>
        </Card>
      ) : (
        <Card className="flex flex-col gap-2 text-sm">
          <ReadRow label="Summary" value={job.summary} />
          <ReadRow label="Description" value={job.description} />
          <ReadRow label="Responsibilities" value={job.responsibilities} />
          <ReadRow label="Qualifications" value={job.qualifications} />
        </Card>
      )}

      <p className="text-xs text-text-muted">
        <Link href="/admin/careers" className="underline underline-offset-2">
          Back to all job openings
        </Link>
      </p>
    </div>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <span className="whitespace-pre-wrap text-text-primary">{value}</span>
    </div>
  );
}
