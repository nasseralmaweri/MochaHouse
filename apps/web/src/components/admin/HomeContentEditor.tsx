"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminCmsPageDetail,
  AdminProductSummary,
  HomePageContent,
} from "@mocha-house/contracts";
import {
  CMS_BUTTON_LABEL_MAX_LENGTH,
  CMS_BODY_MAX_LENGTH,
  CMS_SEO_DESCRIPTION_MAX_LENGTH,
  CMS_SEO_TITLE_MAX_LENGTH,
  CMS_TEXT_MAX_LENGTH,
} from "@mocha-house/contracts";
import {
  publishCmsPageFromBrowser,
  saveCmsPageDraftFromBrowser,
} from "@/lib/api-client";
import { cmsStatusLabel, cmsStatusTone, formatCmsDate } from "@/lib/admin/cms";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { HeroImagePicker } from "./HeroImagePicker";
import { FeaturedProductsSelector } from "./FeaturedProductsSelector";

// Admin → Content → Home editor (Milestone 8F). Structured fields only —
// no raw JSON, no HTML, no layout/component placement. `canManage` gates
// Save draft / Publish (cms.manage); the hero image picker's "Upload new"
// is gated separately on `canUploadMedia` (media.manage) since a user can
// hold one without the other. Featured Products stores ONLY an ordered
// list of product ids — name/price/category are always read live from
// `availableProducts` (the authoritative Admin catalog), never duplicated
// into CMS content. The hero CTA's destination stays code-owned — only its
// label is editable here.
export function HomeContentEditor({
  pageKey,
  initial,
  canManage,
  canUploadMedia,
  availableProducts,
}: {
  pageKey: string;
  initial: AdminCmsPageDetail;
  canManage: boolean;
  canUploadMedia: boolean;
  availableProducts: AdminProductSummary[];
}) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [content, setContent] = useState<HomePageContent>(
    initial.draftContent as HomePageContent,
  );
  const [savePending, setSavePending] = useState(false);
  const [publishPending, setPublishPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  function update(patch: Partial<HomePageContent>) {
    setContent((prev) => ({ ...prev, ...patch }));
    setSavedNotice(false);
  }

  async function saveDraft() {
    setError(null);
    setSavePending(true);
    const result = await saveCmsPageDraftFromBrowser(pageKey, content);
    setSavePending(false);
    if (result.outcome === "success") {
      setDetail(result.detail);
      setContent(result.detail.draftContent as HomePageContent);
      setSavedNotice(true);
      router.refresh();
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You no longer have permission to save content."
        : result.outcome === "not-found"
          ? "This content page no longer exists."
          : result.message,
    );
  }

  async function publish() {
    setError(null);
    setPublishPending(true);
    const result = await publishCmsPageFromBrowser(pageKey);
    setPublishPending(false);
    if (result.outcome === "success") {
      setDetail(result.detail);
      setContent(result.detail.draftContent as HomePageContent);
      setSavedNotice(false);
      router.refresh();
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You no longer have permission to publish."
        : result.outcome === "not-found"
          ? "This content page no longer exists."
          : result.message,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <StatusBadge
            label={cmsStatusLabel(detail.status, detail.hasUnpublishedChanges)}
            tone={cmsStatusTone(detail.status, detail.hasUnpublishedChanges)}
          />
          <span className="text-xs text-text-muted">
            {detail.publishedAt
              ? `Last published ${formatCmsDate(detail.publishedAt)}`
              : "Never published"}
          </span>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void saveDraft()}
              disabled={savePending || publishPending}
            >
              {savePending ? "Saving…" : "Save draft"}
            </Button>
            <Button
              onClick={() => void publish()}
              disabled={savePending || publishPending}
            >
              {publishPending ? "Publishing…" : "Publish"}
            </Button>
          </div>
        ) : null}
      </Card>

      {savedNotice ? (
        <p className="text-sm text-status-success">Draft saved.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <fieldset disabled={!canManage} className="flex flex-col gap-8">
        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">Hero</h2>
          <FormField label="Headline" htmlFor="home-hero-headline">
            <input
              id="home-hero-headline"
              value={content.hero.headline}
              onChange={(e) =>
                update({ hero: { ...content.hero, headline: e.target.value } })
              }
              maxLength={CMS_TEXT_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Supporting text" htmlFor="home-hero-supporting">
            <textarea
              id="home-hero-supporting"
              value={content.hero.supportingText}
              onChange={(e) =>
                update({ hero: { ...content.hero, supportingText: e.target.value } })
              }
              rows={3}
              maxLength={CMS_BODY_MAX_LENGTH}
              className={`${ADMIN_FIELD_CLASS} resize-y`}
            />
          </FormField>
          <FormField
            label="Button label"
            htmlFor="home-hero-button"
            hint="The button always links to online ordering — that destination is not editable here."
          >
            <input
              id="home-hero-button"
              value={content.hero.buttonLabel}
              onChange={(e) =>
                update({ hero: { ...content.hero, buttonLabel: e.target.value } })
              }
              maxLength={CMS_BUTTON_LABEL_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Background image" htmlFor="home-hero-image">
            <HeroImagePicker
              value={content.hero.backgroundImageId}
              onChange={(backgroundImageId) =>
                update({ hero: { ...content.hero, backgroundImageId } })
              }
              canUpload={canUploadMedia}
            />
          </FormField>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">
            Featured Products
          </h2>
          <FormField label="Heading" htmlFor="home-featured-heading">
            <input
              id="home-featured-heading"
              value={content.featuredProducts.heading}
              onChange={(e) =>
                update({
                  featuredProducts: {
                    ...content.featuredProducts,
                    heading: e.target.value,
                  },
                })
              }
              maxLength={CMS_TEXT_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FeaturedProductsSelector
            value={content.featuredProducts.productIds}
            onChange={(productIds) =>
              update({ featuredProducts: { ...content.featuredProducts, productIds } })
            }
            availableProducts={availableProducts}
          />
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">SEO</h2>
          <FormField
            label="Page title (optional)"
            htmlFor="home-seo-title"
            hint="Overrides the browser tab title. Leave blank to use the default."
          >
            <input
              id="home-seo-title"
              value={content.seo.pageTitle ?? ""}
              onChange={(e) =>
                update({ seo: { ...content.seo, pageTitle: e.target.value || null } })
              }
              maxLength={CMS_SEO_TITLE_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField
            label="Meta description (optional)"
            htmlFor="home-seo-description"
            hint="Overrides the search-result description. Leave blank to use the default."
          >
            <textarea
              id="home-seo-description"
              value={content.seo.metaDescription ?? ""}
              onChange={(e) =>
                update({
                  seo: { ...content.seo, metaDescription: e.target.value || null },
                })
              }
              rows={2}
              maxLength={CMS_SEO_DESCRIPTION_MAX_LENGTH}
              className={`${ADMIN_FIELD_CLASS} resize-y`}
            />
          </FormField>
        </Card>
      </fieldset>
    </div>
  );
}
