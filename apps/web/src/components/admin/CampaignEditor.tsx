"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminCampaign, AdminCampaignOptions } from "@mocha-house/contracts";
import {
  updateCampaignFromBrowser,
  updateCampaignStatusFromBrowser,
} from "@/lib/api-client";
import {
  campaignStatusLabel,
  campaignStatusTone,
  formatCampaignDate,
} from "@/lib/admin/marketing";
import { Card } from "@/components/Card";
import { AdminSection } from "./AdminPage";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { CampaignImagePicker } from "./CampaignImagePicker";
import { CampaignFeaturedProductsSelector } from "./CampaignFeaturedProductsSelector";

function toDateInputValue(iso: string | null): string {
  if (!iso) {
    return "";
  }
  return iso.slice(0, 10);
}

export function CampaignEditor({
  initial,
  options,
  canManage,
  canUploadMedia,
}: {
  initial: AdminCampaign;
  options: AdminCampaignOptions | null;
  canManage: boolean;
  canUploadMedia: boolean;
}) {
  const router = useRouter();
  const [campaign, setCampaign] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const ended = campaign.status === "ENDED";
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description ?? "");
  const [startsAt, setStartsAt] = useState(toDateInputValue(campaign.startsAt));
  const [endsAt, setEndsAt] = useState(toDateInputValue(campaign.endsAt));
  const [mediaAssetId, setMediaAssetId] = useState<string | null>(
    campaign.mediaAssetId,
  );
  const [promotionId, setPromotionId] = useState(campaign.promotion?.id ?? "");
  const [loyaltyBonusPromotionId, setLoyaltyBonusPromotionId] = useState(
    campaign.loyaltyBonusPromotion?.id ?? "",
  );
  const [featuredProductIds, setFeaturedProductIds] = useState<string[]>(
    campaign.featuredProducts.map((p) => p.id),
  );

  function applyResult(
    result: Awaited<ReturnType<typeof updateCampaignFromBrowser>>,
  ) {
    if (result.outcome === "success") {
      setCampaign(result.campaign);
      setError(null);
      router.refresh();
      return;
    }
    setError(
      "message" in result
        ? result.message
        : result.outcome === "forbidden"
          ? "You no longer have permission to manage campaigns."
          : "Campaign not found.",
    );
  }

  async function saveFields(event: React.FormEvent) {
    event.preventDefault();
    setPending("save");
    applyResult(
      await updateCampaignFromBrowser(campaign.id, {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        startsAt: startsAt === "" ? null : new Date(startsAt).toISOString(),
        endsAt: endsAt === "" ? null : new Date(endsAt).toISOString(),
        mediaAssetId,
        promotionId: promotionId === "" ? null : promotionId,
        loyaltyBonusPromotionId:
          loyaltyBonusPromotionId === "" ? null : loyaltyBonusPromotionId,
        featuredProductIds,
      }),
    );
    setPending(null);
  }

  async function runStatusAction(status: "ACTIVE" | "ENDED") {
    setPending(status);
    applyResult(await updateCampaignStatusFromBrowser(campaign.id, status));
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-base font-semibold text-text-primary">
            {campaign.name}
          </span>
          <StatusBadge
            label={campaignStatusLabel(campaign.status)}
            tone={campaignStatusTone(campaign.status)}
          />
        </div>
        <p className="text-sm text-text-secondary">
          {formatCampaignDate(campaign.startsAt)} –{" "}
          {formatCampaignDate(campaign.endsAt)}
        </p>

        {canManage ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {campaign.status === "DRAFT" ? (
              <Button
                onClick={() => runStatusAction("ACTIVE")}
                disabled={pending !== null}
              >
                {pending === "ACTIVE" ? "Activating…" : "Activate"}
              </Button>
            ) : null}
            {campaign.status === "ACTIVE" ? (
              <Button
                variant="secondary"
                onClick={() => runStatusAction("ENDED")}
                disabled={pending !== null}
              >
                {pending === "ENDED" ? "Ending…" : "End campaign"}
              </Button>
            ) : null}
            {ended ? (
              <span className="text-sm text-text-secondary">
                This campaign has ended and can no longer be changed.
              </span>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-status-warning">
            {error}
          </p>
        ) : null}
      </Card>

      {canManage && !ended ? (
        <form onSubmit={saveFields} className="flex flex-col gap-6">
          <AdminSection title="Basics">
            <Card className="flex flex-col gap-3">
              <FormField label="Name" htmlFor="edit-campaign-name">
                <input
                  id="edit-campaign-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={ADMIN_FIELD_CLASS}
                />
              </FormField>
              <FormField label="Description" htmlFor="edit-campaign-description">
                <textarea
                  id="edit-campaign-description"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={`${ADMIN_FIELD_CLASS} resize-y`}
                />
              </FormField>
              <div className="flex flex-col gap-3 sm:flex-row">
                <FormField label="Start date" htmlFor="edit-campaign-starts">
                  <input
                    id="edit-campaign-starts"
                    type="date"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    className={ADMIN_FIELD_CLASS}
                  />
                </FormField>
                <FormField label="End date" htmlFor="edit-campaign-ends">
                  <input
                    id="edit-campaign-ends"
                    type="date"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    className={ADMIN_FIELD_CLASS}
                  />
                </FormField>
              </div>
            </Card>
          </AdminSection>

          <AdminSection
            title="Campaign creative"
            description="An optional image from the Media Library."
          >
            <CampaignImagePicker
              value={mediaAssetId}
              onChange={setMediaAssetId}
              canUpload={canUploadMedia}
            />
          </AdminSection>

          <AdminSection
            title="Benefits"
            description="Each linked system remains fully in charge of its own discount or bonus rules."
          >
            <Card className="flex flex-col gap-3">
              <FormField label="Promotion / Coupon" htmlFor="edit-campaign-promotion">
                <select
                  id="edit-campaign-promotion"
                  value={promotionId}
                  onChange={(e) => setPromotionId(e.target.value)}
                  className={ADMIN_FIELD_CLASS}
                >
                  <option value="">None</option>
                  {(options?.promotions ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {!p.isActive ? " (inactive)" : ""}
                    </option>
                  ))}
                  {campaign.promotion &&
                  !(options?.promotions ?? []).some((p) => p.id === campaign.promotion!.id) ? (
                    <option value={campaign.promotion.id}>
                      {campaign.promotion.name}
                      {!campaign.promotion.isActive ? " (inactive)" : ""}
                    </option>
                  ) : null}
                </select>
              </FormField>
              <FormField
                label="Bonus Mocha Bean Promotion"
                htmlFor="edit-campaign-bonus-promotion"
              >
                <select
                  id="edit-campaign-bonus-promotion"
                  value={loyaltyBonusPromotionId}
                  onChange={(e) => setLoyaltyBonusPromotionId(e.target.value)}
                  className={ADMIN_FIELD_CLASS}
                >
                  <option value="">None</option>
                  {(options?.loyaltyBonusPromotions ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {!p.isActive ? " (inactive)" : ""}
                    </option>
                  ))}
                  {campaign.loyaltyBonusPromotion &&
                  !(options?.loyaltyBonusPromotions ?? []).some(
                    (p) => p.id === campaign.loyaltyBonusPromotion!.id,
                  ) ? (
                    <option value={campaign.loyaltyBonusPromotion.id}>
                      {campaign.loyaltyBonusPromotion.name}
                      {!campaign.loyaltyBonusPromotion.isActive ? " (inactive)" : ""}
                    </option>
                  ) : null}
                </select>
              </FormField>
            </Card>
          </AdminSection>

          <AdminSection
            title="Featured products"
            description="Optional. Chooses from the authoritative product catalog — nothing about a product is duplicated here."
          >
            <CampaignFeaturedProductsSelector
              value={featuredProductIds}
              onChange={setFeaturedProductIds}
              availableProducts={options?.products ?? []}
              currentlySelected={campaign.featuredProducts}
            />
          </AdminSection>

          <Button type="submit" disabled={pending !== null} className="self-start">
            {pending === "save" ? "Saving…" : "Save changes"}
          </Button>
        </form>
      ) : (
        <Card className="flex flex-col gap-2 text-sm">
          <ReadRow label="Description" value={campaign.description ?? "—"} />
          <ReadRow
            label="Promotion / Coupon"
            value={campaign.promotion ? campaign.promotion.name : "None"}
          />
          <ReadRow
            label="Bonus Mocha Bean Promotion"
            value={
              campaign.loyaltyBonusPromotion
                ? campaign.loyaltyBonusPromotion.name
                : "None"
            }
          />
          <ReadRow
            label="Featured products"
            value={
              campaign.featuredProducts.length > 0
                ? campaign.featuredProducts.map((p) => p.name).join(", ")
                : "None"
            }
          />
        </Card>
      )}

      <p className="text-xs text-text-muted">
        <Link href="/admin/marketing" className="underline underline-offset-2">
          Back to all campaigns
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
