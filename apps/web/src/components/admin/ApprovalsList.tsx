"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AdminApprovalRequest, ApprovalStatus } from "@mocha-house/contracts";
import { listAdminApprovalsFromBrowser } from "@/lib/api-client";
import {
  approvalStatusLabel,
  approvalStatusTone,
  formatApprovalDate,
} from "@/lib/admin/approvals";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";
import { AdminEmptyState, AdminErrorState } from "./states";

const STATUS_OPTIONS: { value: ApprovalStatus; label: string }[] = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];

// Admin → Approvals list (Milestone 8J). Server-authorised and
// server-loaded for page 1; this island runs the status filter and the
// cursor "load more". Read-only — a row links to the detail page, where
// the actual decision happens.
export function ApprovalsList({
  initial,
}: {
  initial: { approvalRequests: AdminApprovalRequest[]; nextCursor: string | null };
}) {
  const [status, setStatus] = useState<ApprovalStatus | "">("");
  const [approvalRequests, setApprovalRequests] = useState(
    initial.approvalRequests,
  );
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setPending(true);
    setError(null);
    (async () => {
      const result = await listAdminApprovalsFromBrowser({
        status: status || undefined,
      });
      setPending(false);
      if (result.outcome === "forbidden") {
        setError("Your access to approvals was removed.");
        return;
      }
      if (result.outcome !== "success") {
        setError(result.message);
        return;
      }
      setApprovalRequests(result.data.approvalRequests);
      setCursor(result.data.nextCursor);
    })();
  }, [status]);

  async function loadMore() {
    if (!cursor) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await listAdminApprovalsFromBrowser({
      status: status || undefined,
      cursor,
    });
    setPending(false);
    if (result.outcome !== "success") {
      setError(
        result.outcome === "forbidden"
          ? "Your access to approvals was removed."
          : result.message,
      );
      return;
    }
    setApprovalRequests((prev) => [...prev, ...result.data.approvalRequests]);
    setCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex max-w-xs flex-col gap-1 text-xs text-text-secondary">
        Status
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ApprovalStatus | "")}
          className={ADMIN_FIELD_CLASS}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {error ? <AdminErrorState description={error} /> : null}

      {approvalRequests.length === 0 && !pending && !error ? (
        <AdminEmptyState
          title="No approval requests found"
          description={
            status
              ? "No request matches this filter."
              : "No one has requested an approval yet."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {approvalRequests.map((request) => (
            <li key={request.id}>
              <Link
                href={`/admin/approvals/${request.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {request.targetLabel}
                    </span>
                    <span className="truncate text-xs text-text-secondary">
                      Requested by {request.requestedByLabel} ·{" "}
                      {formatApprovalDate(request.createdAt)}
                    </span>
                  </div>
                  <StatusBadge
                    label={approvalStatusLabel(request.status)}
                    tone={approvalStatusTone(request.status)}
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
