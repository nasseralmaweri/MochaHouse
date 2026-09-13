"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AdminCampaign, CampaignStatus } from "@mocha-house/contracts";
import {
  campaignStatusLabel,
  campaignStatusTone,
  formatCampaignDate,
} from "@/lib/admin/marketing";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { ButtonLink } from "./Button";

const STATUS_FILTERS: (CampaignStatus | "ALL")[] = ["ALL", "DRAFT", "ACTIVE", "ENDED"];

export function CampaignsManager({
  campaigns,
  canManage,
}: {
  campaigns: AdminCampaign[];
  canManage: boolean;
}) {
  const [filter, setFilter] = useState<CampaignStatus | "ALL">("ALL");

  const visible = useMemo(
    () =>
      filter === "ALL" ? campaigns : campaigns.filter((c) => c.status === filter),
    [campaigns, filter],
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
              {f === "ALL" ? "All" : campaignStatusLabel(f)}
            </button>
          ))}
        </div>
        {canManage ? (
          <ButtonLink href="/admin/marketing/new" variant="secondary">
            New campaign
          </ButtonLink>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          No campaigns
          {filter === "ALL" ? " yet" : ` with status ${campaignStatusLabel(filter as CampaignStatus)}`}.
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((campaign) => (
            <li key={campaign.id}>
              <Link
                href={`/admin/marketing/${campaign.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {campaign.name}
                    </span>
                    <span className="truncate text-xs text-text-secondary">
                      {formatCampaignDate(campaign.startsAt)} –{" "}
                      {formatCampaignDate(campaign.endsAt)}
                      {campaign.promotion ? ` · ${campaign.promotion.name}` : ""}
                      {campaign.loyaltyBonusPromotion
                        ? ` · ${campaign.loyaltyBonusPromotion.name}`
                        : ""}
                    </span>
                  </div>
                  <StatusBadge
                    label={campaignStatusLabel(campaign.status)}
                    tone={campaignStatusTone(campaign.status)}
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
