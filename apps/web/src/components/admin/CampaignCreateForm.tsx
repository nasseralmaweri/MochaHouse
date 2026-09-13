"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminCampaignOptions } from "@mocha-house/contracts";
import { createCampaignFromBrowser } from "@/lib/api-client";
import { Card } from "@/components/Card";
import { AdminSection } from "./AdminPage";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { CampaignImagePicker } from "./CampaignImagePicker";
import { CampaignFeaturedProductsSelector } from "./CampaignFeaturedProductsSelector";

// Admin → Marketing → New campaign (Milestone 8G). A new campaign always
// starts DRAFT — status changes happen afterward, on the campaign's own
// page. `options` is null when the options lookup failed (e.g. a transient
// error); the form still works, just with empty select lists.
export function CampaignCreateForm({
  options,
  canUploadMedia,
}: {
  options: AdminCampaignOptions | null;
  canUploadMedia: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [mediaAssetId, setMediaAssetId] = useState<string | null>(null);
  const [promotionId, setPromotionId] = useState("");
  const [loyaltyBonusPromotionId, setLoyaltyBonusPromotionId] = useState("");
  const [featuredProductIds, setFeaturedProductIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const result = await createCampaignFromBrowser({
      name: name.trim(),
      description: description.trim() === "" ? null : description.trim(),
      startsAt: startsAt === "" ? null : new Date(startsAt).toISOString(),
      endsAt: endsAt === "" ? null : new Date(endsAt).toISOString(),
      mediaAssetId,
      promotionId: promotionId === "" ? null : promotionId,
      loyaltyBonusPromotionId:
        loyaltyBonusPromotionId === "" ? null : loyaltyBonusPromotionId,
      featuredProductIds,
    });
    setPending(false);
    if (result.outcome === "success") {
      router.push(`/admin/marketing/${result.campaign.id}`);
      return;
    }
    setError(
      "message" in result
        ? result.message
        : result.outcome === "forbidden"
          ? "You don't have permission to create campaigns."
          : "Couldn't create that campaign.",
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <AdminSection title="Basics">
        <Card className="flex flex-col gap-3">
          <FormField label="Name" htmlFor="campaign-name">
            <input
              id="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Description" htmlFor="campaign-description">
            <textarea
              id="campaign-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`${ADMIN_FIELD_CLASS} resize-y`}
            />
          </FormField>
          <div className="flex flex-col gap-3 sm:flex-row">
            <FormField label="Start date" htmlFor="campaign-starts">
              <input
                id="campaign-starts"
                type="date"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className={ADMIN_FIELD_CLASS}
              />
            </FormField>
            <FormField label="End date" htmlFor="campaign-ends">
              <input
                id="campaign-ends"
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
        description="Optionally link an existing Promotion / Coupon and/or an existing Bonus Mocha Bean Promotion. Each remains fully in charge of its own discount or bonus rules."
      >
        <Card className="flex flex-col gap-3">
          <FormField label="Promotion / Coupon" htmlFor="campaign-promotion">
            <select
              id="campaign-promotion"
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
            </select>
          </FormField>
          <FormField
            label="Bonus Mocha Bean Promotion"
            htmlFor="campaign-bonus-promotion"
          >
            <select
              id="campaign-bonus-promotion"
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
          currentlySelected={[]}
        />
      </AdminSection>

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending || name.trim() === ""} className="self-start">
        {pending ? "Creating…" : "Create draft campaign"}
      </Button>
    </form>
  );
}
