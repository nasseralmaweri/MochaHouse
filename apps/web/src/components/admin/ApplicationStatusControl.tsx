"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { JobApplicationStatus } from "@mocha-house/contracts";
import { updateJobApplicationStatusFromBrowser } from "@/lib/api-client";
import {
  APPLICATION_STATUS_OPTIONS,
  applicationStatusLabel,
} from "@/lib/admin/applicants";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";

// Admin → Applicant detail → status (Milestone 8C). Rendered only for
// `applicants.manage`; the API re-checks. There is no transition graph — any
// valid status can move to any other valid status through the dedicated
// action, and the API audits every change (status only, no PII).
export function ApplicationStatusControl({
  applicationId,
  status,
}: {
  applicationId: string;
  status: JobApplicationStatus;
}) {
  const router = useRouter();
  const [next, setNext] = useState<JobApplicationStatus>(status);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setPending(true);
    const result = await updateJobApplicationStatusFromBrowser(
      applicationId,
      next,
    );
    setPending(false);
    if (result.outcome === "success") {
      router.refresh();
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You no longer have permission to change an application's status."
        : result.outcome === "not-found"
          ? "This application no longer exists."
          : result.message,
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="applicant-status" className="sr-only">
          Application status
        </label>
        <select
          id="applicant-status"
          value={next}
          onChange={(e) => setNext(e.target.value as JobApplicationStatus)}
          className={ADMIN_FIELD_CLASS}
        >
          {APPLICATION_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          onClick={() => void submit()}
          disabled={pending || next === status}
        >
          {pending ? "Working…" : "Update status"}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Currently {applicationStatusLabel(status)}.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}
