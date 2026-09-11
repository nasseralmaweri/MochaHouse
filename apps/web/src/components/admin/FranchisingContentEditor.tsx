"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminCmsPageDetail,
  FranchisingPageContent,
} from "@mocha-house/contracts";
import {
  CMS_BODY_MAX_LENGTH,
  CMS_BUTTON_LABEL_MAX_LENGTH,
  CMS_PROCESS_STEPS_MAX,
  CMS_PROCESS_STEPS_MIN,
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

// Admin → Content → Franchising editor (Milestone 8E). Structured fields
// only — no raw JSON, no HTML, no arbitrary layout. `canManage` gates both
// actions; a read-only viewer (`cms.view` alone) sees the same fields but
// no Save draft / Publish controls. The CTA's destination stays code-owned
// by the public page — this editor only supplies heading/body/button text.
export function FranchisingContentEditor({
  pageKey,
  initial,
  canManage,
}: {
  pageKey: string;
  initial: AdminCmsPageDetail;
  canManage: boolean;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [content, setContent] = useState<FranchisingPageContent>(
    initial.draftContent as FranchisingPageContent,
  );
  const [savePending, setSavePending] = useState(false);
  const [publishPending, setPublishPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  function update(patch: Partial<FranchisingPageContent>) {
    setContent((prev) => ({ ...prev, ...patch }));
    setSavedNotice(false);
  }

  function updateStep(index: number, patch: { title?: string; body?: string }) {
    update({
      process: {
        ...content.process,
        steps: content.process.steps.map((step, i) =>
          i === index ? { ...step, ...patch } : step,
        ),
      },
    });
  }

  function addStep() {
    if (content.process.steps.length >= CMS_PROCESS_STEPS_MAX) {
      return;
    }
    update({
      process: {
        ...content.process,
        steps: [...content.process.steps, { title: "", body: "" }],
      },
    });
  }

  function removeStep(index: number) {
    if (content.process.steps.length <= CMS_PROCESS_STEPS_MIN) {
      return;
    }
    update({
      process: {
        ...content.process,
        steps: content.process.steps.filter((_, i) => i !== index),
      },
    });
  }

  async function saveDraft() {
    setError(null);
    setSavePending(true);
    const result = await saveCmsPageDraftFromBrowser(pageKey, content);
    setSavePending(false);
    if (result.outcome === "success") {
      setDetail(result.detail);
      setContent(result.detail.draftContent as FranchisingPageContent);
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
      setContent(result.detail.draftContent as FranchisingPageContent);
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
          <h2 className="text-base font-semibold text-text-primary">
            Introduction
          </h2>
          <FormField label="Heading" htmlFor="cms-intro-heading">
            <input
              id="cms-intro-heading"
              value={content.intro.heading}
              onChange={(e) =>
                update({ intro: { ...content.intro, heading: e.target.value } })
              }
              maxLength={CMS_TEXT_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Body" htmlFor="cms-intro-body">
            <textarea
              id="cms-intro-body"
              value={content.intro.body}
              onChange={(e) =>
                update({ intro: { ...content.intro, body: e.target.value } })
              }
              rows={3}
              maxLength={CMS_BODY_MAX_LENGTH}
              className={`${ADMIN_FIELD_CLASS} resize-y`}
            />
          </FormField>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">
            Opportunity
          </h2>
          <FormField label="Heading" htmlFor="cms-opportunity-heading">
            <input
              id="cms-opportunity-heading"
              value={content.opportunity.heading}
              onChange={(e) =>
                update({
                  opportunity: { ...content.opportunity, heading: e.target.value },
                })
              }
              maxLength={CMS_TEXT_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Body" htmlFor="cms-opportunity-body">
            <textarea
              id="cms-opportunity-body"
              value={content.opportunity.body}
              onChange={(e) =>
                update({
                  opportunity: { ...content.opportunity, body: e.target.value },
                })
              }
              rows={3}
              maxLength={CMS_BODY_MAX_LENGTH}
              className={`${ADMIN_FIELD_CLASS} resize-y`}
            />
          </FormField>
        </Card>

        <Card className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-text-primary">
              Process
            </h2>
            {canManage && content.process.steps.length < CMS_PROCESS_STEPS_MAX ? (
              <Button variant="secondary" onClick={addStep} type="button">
                Add step
              </Button>
            ) : null}
          </div>
          <FormField label="Heading" htmlFor="cms-process-heading">
            <input
              id="cms-process-heading"
              value={content.process.heading}
              onChange={(e) =>
                update({
                  process: { ...content.process, heading: e.target.value },
                })
              }
              maxLength={CMS_TEXT_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <div className="flex flex-col gap-4">
            {content.process.steps.map((step, index) => (
              <div
                key={index}
                className="flex flex-col gap-2 rounded-xl border border-border-default p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                    Step {index + 1}
                  </span>
                  {canManage &&
                  content.process.steps.length > CMS_PROCESS_STEPS_MIN ? (
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => removeStep(index)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                <FormField label="Title" htmlFor={`cms-step-${index}-title`}>
                  <input
                    id={`cms-step-${index}-title`}
                    value={step.title}
                    onChange={(e) => updateStep(index, { title: e.target.value })}
                    maxLength={CMS_TEXT_MAX_LENGTH}
                    className={ADMIN_FIELD_CLASS}
                  />
                </FormField>
                <FormField label="Body" htmlFor={`cms-step-${index}-body`}>
                  <textarea
                    id={`cms-step-${index}-body`}
                    value={step.body}
                    onChange={(e) => updateStep(index, { body: e.target.value })}
                    rows={2}
                    maxLength={CMS_BODY_MAX_LENGTH}
                    className={`${ADMIN_FIELD_CLASS} resize-y`}
                  />
                </FormField>
              </div>
            ))}
          </div>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">CTA</h2>
          <FormField label="Heading" htmlFor="cms-cta-heading">
            <input
              id="cms-cta-heading"
              value={content.cta.heading}
              onChange={(e) =>
                update({ cta: { ...content.cta, heading: e.target.value } })
              }
              maxLength={CMS_TEXT_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Body" htmlFor="cms-cta-body">
            <textarea
              id="cms-cta-body"
              value={content.cta.body}
              onChange={(e) =>
                update({ cta: { ...content.cta, body: e.target.value } })
              }
              rows={2}
              maxLength={CMS_BODY_MAX_LENGTH}
              className={`${ADMIN_FIELD_CLASS} resize-y`}
            />
          </FormField>
          <FormField
            label="Button label"
            htmlFor="cms-cta-button"
            hint="The button always links to the franchise inquiry form — that destination is not editable here."
          >
            <input
              id="cms-cta-button"
              value={content.cta.buttonLabel}
              onChange={(e) =>
                update({ cta: { ...content.cta, buttonLabel: e.target.value } })
              }
              maxLength={CMS_BUTTON_LABEL_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">SEO</h2>
          <FormField
            label="Page title (optional)"
            htmlFor="cms-seo-title"
            hint="Overrides the browser tab title. Leave blank to use the default."
          >
            <input
              id="cms-seo-title"
              value={content.seo.pageTitle ?? ""}
              onChange={(e) =>
                update({
                  seo: { ...content.seo, pageTitle: e.target.value || null },
                })
              }
              maxLength={CMS_SEO_TITLE_MAX_LENGTH}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField
            label="Meta description (optional)"
            htmlFor="cms-seo-description"
            hint="Overrides the search-result description. Leave blank to use the default."
          >
            <textarea
              id="cms-seo-description"
              value={content.seo.metaDescription ?? ""}
              onChange={(e) =>
                update({
                  seo: {
                    ...content.seo,
                    metaDescription: e.target.value || null,
                  },
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
