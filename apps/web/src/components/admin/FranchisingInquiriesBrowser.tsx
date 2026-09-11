"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  AdminFranchiseInquirySummary,
  FranchiseInquiryStatus,
} from "@mocha-house/contracts";
import { listAdminFranchiseInquiriesFromBrowser } from "@/lib/api-client";
import {
  INQUIRY_STATUS_OPTIONS,
  formatInquiryDate,
  inquiryStatusLabel,
  inquiryStatusTone,
} from "@/lib/admin/franchising";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";
import { AdminEmptyState, AdminErrorState } from "./states";

// Admin → Franchising list (Milestone 8D). Server-authorised and
// server-loaded for page 1; this island runs the status filter and the
// cursor "load more". Read-only — a row links to the detail page. A single
// flat area — no sub-tabs.
export function FranchisingInquiriesBrowser({
  initial,
}: {
  initial: {
    inquiries: AdminFranchiseInquirySummary[];
    nextCursor: string | null;
  };
}) {
  const [status, setStatus] = useState<FranchiseInquiryStatus | "">("");
  const [inquiries, setInquiries] = useState(initial.inquiries);
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
      const result = await listAdminFranchiseInquiriesFromBrowser({
        status: status || undefined,
      });
      if (id !== requestId.current) {
        return;
      }
      setPending(false);
      if (result.outcome === "forbidden") {
        setError("Your access to franchise inquiries was removed.");
        return;
      }
      if (result.outcome !== "success") {
        setError(result.message);
        return;
      }
      setInquiries(result.data.inquiries);
      setCursor(result.data.nextCursor);
    })();
  }, [status]);

  async function loadMore() {
    if (!cursor) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await listAdminFranchiseInquiriesFromBrowser({
      status: status || undefined,
      cursor,
    });
    setPending(false);
    if (result.outcome !== "success") {
      setError(
        result.outcome === "forbidden"
          ? "Your access to franchise inquiries was removed."
          : result.message,
      );
      return;
    }
    setInquiries((prev) => [...prev, ...result.data.inquiries]);
    setCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex max-w-xs flex-col gap-1 text-xs text-text-secondary">
        Status
        <select
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as FranchiseInquiryStatus | "")
          }
          className={ADMIN_FIELD_CLASS}
        >
          <option value="">All statuses</option>
          {INQUIRY_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {error ? <AdminErrorState description={error} /> : null}

      {inquiries.length === 0 && !pending && !error ? (
        <AdminEmptyState
          title="No inquiries found"
          description={
            status
              ? "No inquiry matches this filter."
              : "No one has submitted a franchise inquiry yet."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {inquiries.map((inquiry) => (
            <li key={inquiry.id}>
              <Link
                href={`/admin/franchising/${inquiry.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {inquiry.prospectName}
                    </span>
                    <span className="truncate text-xs text-text-secondary">
                      {inquiry.email} · {inquiry.preferredMarket} · submitted{" "}
                      {formatInquiryDate(inquiry.createdAt)}
                    </span>
                  </div>
                  <StatusBadge
                    label={inquiryStatusLabel(inquiry.status)}
                    tone={inquiryStatusTone(inquiry.status)}
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
