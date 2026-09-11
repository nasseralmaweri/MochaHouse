"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FranchiseInquiryStatus } from "@mocha-house/contracts";
import { updateFranchiseInquiryStatusFromBrowser } from "@/lib/api-client";
import {
  INQUIRY_STATUS_OPTIONS,
  inquiryStatusLabel,
} from "@/lib/admin/franchising";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";

// Admin → Franchise inquiry detail → status (Milestone 8D). Rendered only
// for `franchising.manage`; the API re-checks. There is no transition
// graph — any valid status can move to any other valid status through the
// dedicated action, and the API audits every change (status only, no PII).
export function FranchiseInquiryStatusControl({
  inquiryId,
  status,
}: {
  inquiryId: string;
  status: FranchiseInquiryStatus;
}) {
  const router = useRouter();
  const [next, setNext] = useState<FranchiseInquiryStatus>(status);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setPending(true);
    const result = await updateFranchiseInquiryStatusFromBrowser(
      inquiryId,
      next,
    );
    setPending(false);
    if (result.outcome === "success") {
      router.refresh();
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You no longer have permission to change an inquiry's status."
        : result.outcome === "not-found"
          ? "This inquiry no longer exists."
          : result.message,
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="inquiry-status" className="sr-only">
          Inquiry status
        </label>
        <select
          id="inquiry-status"
          value={next}
          onChange={(e) => setNext(e.target.value as FranchiseInquiryStatus)}
          className={ADMIN_FIELD_CLASS}
        >
          {INQUIRY_STATUS_OPTIONS.map((o) => (
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
        Currently {inquiryStatusLabel(status)}.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}
