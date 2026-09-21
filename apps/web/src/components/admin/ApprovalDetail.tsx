"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminApprovalRequest,
  AdminCampaign,
  AdminMediaAsset,
} from "@mocha-house/contracts";
import {
  approveApprovalRequestFromBrowser,
  rejectApprovalRequestFromBrowser,
} from "@/lib/api-client";
import {
  approvalStatusLabel,
  approvalStatusTone,
  formatApprovalDate,
} from "@/lib/admin/approvals";
import { formatCampaignDate } from "@/lib/admin/marketing";
import { Card } from "@/components/Card";
import { AdminSection } from "./AdminPage";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right text-text-primary">{value}</span>
    </div>
  );
}

// Admin → Approvals → detail (Milestone 8J). Decision controls render only
// when `canDecide` (the page has already checked `approvals.decide`); the
// API re-checks, including that the decider isn't the requester. No
// confirmation dialog on Approve, matching every other direct-action
// control in Admin (Media's Remove, Franchising/Careers status changes).
export function ApprovalDetail({
  approvalRequest: initial,
  campaign,
  mediaAsset,
  canDecide,
}: {
  approvalRequest: AdminApprovalRequest;
  campaign: AdminCampaign | null;
  mediaAsset: AdminMediaAsset | null;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [approvalRequest, setApprovalRequest] = useState(initial);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function describeError(
    result: Awaited<ReturnType<typeof approveApprovalRequestFromBrowser>>,
  ): string {
    if (result.outcome === "forbidden") {
      return "You no longer have permission to decide this request.";
    }
    if (result.outcome === "not-found") {
      return "This approval request no longer exists.";
    }
    return "message" in result ? result.message : "Something went wrong.";
  }

  async function handleApprove() {
    setPending("approve");
    setError(null);
    const result = await approveApprovalRequestFromBrowser(approvalRequest.id);
    setPending(null);
    if (result.outcome === "success") {
      setApprovalRequest(result.approvalRequest);
      router.refresh();
      return;
    }
    setError(describeError(result));
  }

  async function handleReject(event: React.FormEvent) {
    event.preventDefault();
    if (reason.trim().length === 0) {
      setError("A reason is required to reject a request.");
      return;
    }
    setPending("reject");
    setError(null);
    const result = await rejectApprovalRequestFromBrowser(
      approvalRequest.id,
      reason.trim(),
    );
    setPending(null);
    if (result.outcome === "success") {
      setApprovalRequest(result.approvalRequest);
      setReason("");
      router.refresh();
      return;
    }
    setError(describeError(result));
  }

  return (
    <div className="flex flex-col gap-8">
      <AdminSection title="Request">
        <Card className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-base font-semibold text-text-primary">
              {approvalRequest.targetLabel}
            </span>
            <StatusBadge
              label={approvalStatusLabel(approvalRequest.status)}
              tone={approvalStatusTone(approvalRequest.status)}
            />
          </div>
          <Row label="Requested by" value={approvalRequest.requestedByLabel} />
          <Row
            label="Requested"
            value={formatApprovalDate(approvalRequest.createdAt)}
          />
          {approvalRequest.decidedByLabel ? (
            <Row label="Decided by" value={approvalRequest.decidedByLabel} />
          ) : null}
          {approvalRequest.decidedAt ? (
            <Row
              label="Decided"
              value={formatApprovalDate(approvalRequest.decidedAt)}
            />
          ) : null}
          {approvalRequest.decisionReason ? (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Rejection reason</span>
              <p className="whitespace-pre-wrap text-text-primary">
                {approvalRequest.decisionReason}
              </p>
            </div>
          ) : null}
        </Card>
      </AdminSection>

      {campaign ? (
        <AdminSection
          title="Campaign being reviewed"
          description="Read-only — decide here, edit the campaign itself from Marketing."
        >
          <Card className="flex flex-col gap-3">
            {mediaAsset ? (
              // eslint-disable-next-line @next/next/no-img-element -- Admin-only preview thumbnail.
              <img
                src={mediaAsset.publicUrl}
                alt={mediaAsset.altText ?? mediaAsset.fileName}
                className="h-32 w-32 rounded-lg object-cover"
              />
            ) : null}
            {campaign.description ? (
              <p className="whitespace-pre-wrap text-sm text-text-primary">
                {campaign.description}
              </p>
            ) : null}
            <Row
              label="Dates"
              value={`${formatCampaignDate(campaign.startsAt)} – ${formatCampaignDate(campaign.endsAt)}`}
            />
            <Row
              label="Promotion / Coupon"
              value={campaign.promotion ? campaign.promotion.name : "None"}
            />
            <Row
              label="Bonus Mocha Bean Promotion"
              value={
                campaign.loyaltyBonusPromotion
                  ? campaign.loyaltyBonusPromotion.name
                  : "None"
              }
            />
            <Row
              label="Featured products"
              value={
                campaign.featuredProducts.length > 0
                  ? campaign.featuredProducts.map((p) => p.name).join(", ")
                  : "None"
              }
            />
          </Card>
        </AdminSection>
      ) : null}

      <AdminSection title="Decision">
        {approvalRequest.status !== "PENDING" ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            This request has already been {approvalStatusLabel(approvalRequest.status).toLowerCase()}.
          </Card>
        ) : canDecide ? (
          <Card className="flex flex-col gap-4">
            {error ? (
              <p role="alert" className="text-sm text-status-warning">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button
                type="button"
                onClick={() => void handleApprove()}
                disabled={pending !== null}
              >
                {pending === "approve" ? "Approving…" : "Approve"}
              </Button>
            </div>
            <form onSubmit={handleReject} className="flex flex-col gap-2">
              <FormField
                label="Reject with a reason"
                htmlFor="approval-reject-reason"
                hint="Required. The requester will need to address this before resubmitting."
              >
                <textarea
                  id="approval-reject-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  className={`${ADMIN_FIELD_CLASS} resize-y`}
                />
              </FormField>
              <Button
                type="submit"
                variant="secondary"
                disabled={pending !== null}
                className="self-start"
              >
                {pending === "reject" ? "Rejecting…" : "Reject"}
              </Button>
            </form>
          </Card>
        ) : (
          <Card tone="subtle" className="text-sm text-text-secondary">
            You don&apos;t have permission to decide this request.
          </Card>
        )}
      </AdminSection>
    </div>
  );
}
