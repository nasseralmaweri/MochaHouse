"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  AdminJobOpening,
  AdminJobOpeningOptions,
  JobEmploymentType,
  JobOpeningStatus,
} from "@mocha-house/contracts";
import { createJobOpeningFromBrowser } from "@/lib/api-client";
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

const STATUS_FILTERS: (JobOpeningStatus | "ALL")[] = [
  "ALL",
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
];

export function CareersManager({
  jobs,
  options,
  canManage,
}: {
  jobs: AdminJobOpening[];
  options: AdminJobOpeningOptions | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<JobOpeningStatus | "ALL">("ALL");
  const [showForm, setShowForm] = useState(false);

  const visible = useMemo(
    () => (filter === "ALL" ? jobs : jobs.filter((j) => j.status === filter)),
    [jobs, filter],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                filter === f
                  ? "bg-status-success/10 text-status-success"
                  : "bg-surface-subtle text-text-secondary"
              }`}
            >
              {f === "ALL" ? "All" : jobStatusLabel(f)}
            </button>
          ))}
        </div>
        {canManage ? (
          <Button
            variant="secondary"
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Cancel" : "New job opening"}
          </Button>
        ) : null}
      </div>

      {showForm && canManage ? (
        <CreateJobForm
          options={options}
          onCreated={(job) => {
            setShowForm(false);
            router.push(`/admin/careers/${job.id}`);
          }}
        />
      ) : null}

      {visible.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          No job openings{filter === "ALL" ? " yet" : ` with status ${jobStatusLabel(filter as JobOpeningStatus)}`}.
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((job) => (
            <li key={job.id}>
              <Link
                href={`/admin/careers/${job.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {job.title}
                    </span>
                    <span className="truncate text-xs text-text-secondary">
                      {jobLocationLabel(job.location)} ·{" "}
                      {employmentTypeLabel(job.employmentType)} · updated{" "}
                      {formatJobDate(job.updatedAt)}
                    </span>
                  </div>
                  <StatusBadge
                    label={jobStatusLabel(job.status)}
                    tone={jobStatusTone(job.status)}
                  />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateJobForm({
  options,
  onCreated,
}: {
  options: AdminJobOpeningOptions | null;
  onCreated: (job: AdminJobOpening) => void;
}) {
  const [title, setTitle] = useState("");
  const [employmentType, setEmploymentType] =
    useState<JobEmploymentType>("FULL_TIME");
  const [locationId, setLocationId] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [responsibilities, setResponsibilities] = useState("");
  const [qualifications, setQualifications] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const result = await createJobOpeningFromBrowser({
      title: title.trim(),
      employmentType,
      locationId: locationId === "" ? null : locationId,
      summary: summary.trim(),
      description: description.trim(),
      responsibilities: responsibilities.trim(),
      qualifications: qualifications.trim(),
    });
    setPending(false);
    if (result.outcome === "success") {
      onCreated(result.job);
      return;
    }
    setError(
      "message" in result
        ? result.message
        : result.outcome === "forbidden"
          ? "You no longer have permission to create job openings."
          : "Couldn't create that job opening.",
    );
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <FormField label="Title" htmlFor="job-title">
          <input
            id="job-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={ADMIN_FIELD_CLASS}
          />
        </FormField>
        <FormField label="Employment type" htmlFor="job-type">
          <select
            id="job-type"
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
        <FormField
          label="Location"
          htmlFor="job-location"
          hint="Leave as Corporate / HQ for a company-wide role."
        >
          <select
            id="job-location"
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
        <FormField label="Short summary" htmlFor="job-summary">
          <input
            id="job-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className={ADMIN_FIELD_CLASS}
          />
        </FormField>
        <FormField label="Description" htmlFor="job-desc">
          <textarea
            id="job-desc"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${ADMIN_FIELD_CLASS} resize-y`}
          />
        </FormField>
        <FormField label="Responsibilities" htmlFor="job-resp">
          <textarea
            id="job-resp"
            rows={3}
            value={responsibilities}
            onChange={(e) => setResponsibilities(e.target.value)}
            className={`${ADMIN_FIELD_CLASS} resize-y`}
          />
        </FormField>
        <FormField
          label="Qualifications"
          htmlFor="job-qual"
          error={error}
        >
          <textarea
            id="job-qual"
            rows={3}
            value={qualifications}
            onChange={(e) => setQualifications(e.target.value)}
            className={`${ADMIN_FIELD_CLASS} resize-y`}
          />
        </FormField>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Creating…" : "Create draft"}
        </Button>
      </form>
    </Card>
  );
}
