"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  AdminJobApplicationSummary,
  JobApplicationStatus,
} from "@mocha-house/contracts";
import { listAdminJobApplicationsFromBrowser } from "@/lib/api-client";
import {
  APPLICATION_STATUS_OPTIONS,
  applicationStatusLabel,
  applicationStatusTone,
  formatApplicantDate,
} from "@/lib/admin/applicants";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";
import { AdminEmptyState, AdminErrorState } from "./states";

interface JobOption {
  id: string;
  title: string;
}

// Admin → Careers → Applicants list (Milestone 8C). Server-authorised and
// server-loaded for page 1; this island runs the status / job filters and
// the cursor "load more". Read-only — a row links to the detail page.
export function ApplicantsBrowser({
  initial,
  jobOptions,
}: {
  initial: {
    applications: AdminJobApplicationSummary[];
    nextCursor: string | null;
  };
  jobOptions: JobOption[];
}) {
  const [status, setStatus] = useState<JobApplicationStatus | "">("");
  const [jobOpeningId, setJobOpeningId] = useState("");
  const [applications, setApplications] = useState(initial.applications);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const firstRender = useRef(true);

  useEffect(() => {
    // Skip the initial render — page 1 is already server-loaded.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const id = ++requestId.current;
    setPending(true);
    setError(null);
    (async () => {
      const result = await listAdminJobApplicationsFromBrowser({
        status: status || undefined,
        jobOpeningId: jobOpeningId || undefined,
      });
      if (id !== requestId.current) {
        return;
      }
      setPending(false);
      if (result.outcome === "forbidden") {
        setError("Your access to applicants was removed.");
        return;
      }
      if (result.outcome !== "success") {
        setError(result.message);
        return;
      }
      setApplications(result.data.applications);
      setCursor(result.data.nextCursor);
    })();
  }, [status, jobOpeningId]);

  async function loadMore() {
    if (!cursor) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await listAdminJobApplicationsFromBrowser({
      status: status || undefined,
      jobOpeningId: jobOpeningId || undefined,
      cursor,
    });
    setPending(false);
    if (result.outcome !== "success") {
      setError(
        result.outcome === "forbidden"
          ? "Your access to applicants was removed."
          : result.message,
      );
      return;
    }
    setApplications((prev) => [...prev, ...result.data.applications]);
    setCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          Status
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as JobApplicationStatus | "")
            }
            className={ADMIN_FIELD_CLASS}
          >
            <option value="">All statuses</option>
            {APPLICATION_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          Job
          <select
            value={jobOpeningId}
            onChange={(e) => setJobOpeningId(e.target.value)}
            className={ADMIN_FIELD_CLASS}
          >
            <option value="">All jobs</option>
            {jobOptions.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <AdminErrorState description={error} /> : null}

      {applications.length === 0 && !pending && !error ? (
        <AdminEmptyState
          title="No applications found"
          description={
            status || jobOpeningId
              ? "No application matches these filters."
              : "No one has applied yet."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {applications.map((application) => (
            <li key={application.id}>
              <Link
                href={`/admin/careers/applicants/${application.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {application.applicantName}
                    </span>
                    <span className="truncate text-xs text-text-secondary">
                      {application.jobTitleSnapshot} · {application.email} ·
                      applied {formatApplicantDate(application.createdAt)}
                    </span>
                  </div>
                  <StatusBadge
                    label={applicationStatusLabel(application.status)}
                    tone={applicationStatusTone(application.status)}
                  />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {cursor ? (
        <Button
          variant="secondary"
          onClick={loadMore}
          disabled={pending}
          className="self-start"
        >
          {pending ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
