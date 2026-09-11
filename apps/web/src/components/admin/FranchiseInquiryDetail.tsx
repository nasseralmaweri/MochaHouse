import Link from "next/link";
import type { AdminFranchiseInquiryDetail as InquiryDetail } from "@mocha-house/contracts";
import {
  formatInquiryDate,
  inquiryActivityLine,
  inquiryStatusLabel,
  inquiryStatusTone,
  prospectName,
} from "@/lib/admin/franchising";
import { Card } from "@/components/Card";
import { AdminSection } from "./AdminPage";
import { StatusBadge } from "./StatusBadge";
import { FranchiseInquiryStatusControl } from "./FranchiseInquiryStatusControl";
import { FranchiseInquiryNotesPanel } from "./FranchiseInquiryNotesPanel";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right text-text-primary">{value}</span>
    </div>
  );
}

// Admin → Franchising → detail (Milestone 8D). Read-only presentation of
// one franchise inquiry, plus the status control and the append-only
// internal notes when the viewer holds `franchising.manage`. Prospect PII
// is shown here because the page is CORPORATE-only and the API enforces it.
export function FranchiseInquiryDetail({
  detail,
  canManage,
}: {
  detail: InquiryDetail;
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      <AdminSection title="Prospect">
        <Card className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-base font-semibold text-text-primary">
              {prospectName(detail.firstName, detail.lastName)}
            </span>
            <StatusBadge
              label={inquiryStatusLabel(detail.status)}
              tone={inquiryStatusTone(detail.status)}
            />
          </div>
          <Row label="Email" value={detail.email} />
          <Row label="Phone" value={detail.phone} />
          <Row
            label="Location"
            value={`${detail.city}, ${detail.state}, ${detail.country}`}
          />
          <Row
            label="Submitted"
            value={formatInquiryDate(detail.createdAt)}
          />
        </Card>
      </AdminSection>

      <AdminSection title="Interest">
        <Card className="flex flex-col gap-3">
          <Row label="Preferred market" value={detail.preferredMarket} />
          {detail.investmentRange ? (
            <Row label="Investment range" value={detail.investmentRange} />
          ) : null}
          {detail.timeframe ? (
            <Row label="Timeframe" value={detail.timeframe} />
          ) : null}
          {detail.businessExperience ? (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Business experience</span>
              <p className="whitespace-pre-wrap text-text-primary">
                {detail.businessExperience}
              </p>
            </div>
          ) : null}
          {detail.message ? (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">
                Additional information
              </span>
              <p className="whitespace-pre-wrap text-text-primary">
                {detail.message}
              </p>
            </div>
          ) : null}
          <Row
            label="Consent to be contacted"
            value={detail.consentAcknowledged ? "Acknowledged" : "Not recorded"}
          />
        </Card>
      </AdminSection>

      <AdminSection
        title="Status"
        description="Any status can move to any other status. Every change is recorded."
      >
        {canManage ? (
          <FranchiseInquiryStatusControl
            inquiryId={detail.id}
            status={detail.status}
          />
        ) : (
          <Card tone="subtle" className="text-sm text-text-secondary">
            Currently {inquiryStatusLabel(detail.status)}. You don&apos;t have
            permission to change it.
          </Card>
        )}
      </AdminSection>

      <AdminSection
        title="Internal notes"
        description="Staff-only. Append-only in this release."
      >
        <FranchiseInquiryNotesPanel
          inquiryId={detail.id}
          initialNotes={detail.notes}
          canManage={canManage}
        />
      </AdminSection>

      <AdminSection title="Activity">
        {detail.activity.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No recorded activity for this inquiry yet.
          </Card>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm text-text-secondary">
            {detail.activity.map((item) => (
              <li key={item.id}>{inquiryActivityLine(item)}</li>
            ))}
          </ul>
        )}
      </AdminSection>

      <p className="text-xs text-text-muted">
        <Link href="/admin/franchising" className="underline underline-offset-2">
          Back to all inquiries
        </Link>
      </p>
    </div>
  );
}
