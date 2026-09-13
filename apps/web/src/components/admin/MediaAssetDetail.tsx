"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminMediaAsset } from "@mocha-house/contracts";
import {
  deactivateMediaAssetFromBrowser,
  updateMediaAssetMetadataFromBrowser,
} from "@/lib/api-client";
import { formatFileSize, formatMediaDate } from "@/lib/admin/media";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { StatusBadge } from "./StatusBadge";

// Admin → Media → detail (Milestone 8I). Read-only technical metadata
// (filename, type, size, uploader, timestamps, active/archived state) plus
// the only two editable fields (title, alt text) and the existing archive
// action — no new archive behavior, no confirmation dialog (the library
// grid's own "Remove" has never had one either).
export function MediaAssetDetail({
  asset: initialAsset,
  canManage,
}: {
  asset: AdminMediaAsset;
  canManage: boolean;
}) {
  const router = useRouter();
  const [asset, setAsset] = useState(initialAsset);
  const [title, setTitle] = useState(initialAsset.title ?? "");
  const [altText, setAltText] = useState(initialAsset.altText ?? "");
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const trimmedTitle = title.trim();
    const trimmedAltText = altText.trim();
    const result = await updateMediaAssetMetadataFromBrowser(asset.id, {
      title: trimmedTitle === "" ? null : trimmedTitle,
      altText: trimmedAltText === "" ? null : trimmedAltText,
    });
    setSaving(false);
    if (result.outcome === "success") {
      setAsset(result.asset);
      setTitle(result.asset.title ?? "");
      setAltText(result.asset.altText ?? "");
      setSaved(true);
      router.refresh();
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You no longer have permission to edit this image."
        : result.outcome === "not-found"
          ? "This image no longer exists."
          : result.outcome === "invalid"
            ? result.message
            : result.message,
    );
  }

  async function handleArchive() {
    setArchiving(true);
    setError(null);
    setSaved(false);
    const result = await deactivateMediaAssetFromBrowser(asset.id);
    setArchiving(false);
    if (result.outcome === "success") {
      setAsset(result.asset);
      router.refresh();
      return;
    }
    setError(
      result.outcome === "conflict"
        ? result.message
        : result.outcome === "forbidden"
          ? "You no longer have permission to archive images."
          : result.outcome === "not-found"
            ? "This image no longer exists."
            : result.message,
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <Card className="flex flex-col items-start gap-3 lg:w-80 lg:flex-shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element -- Admin-only preview; host is operator-configured. */}
        <img
          src={asset.publicUrl}
          alt={asset.altText ?? asset.fileName}
          className="aspect-square w-full rounded-lg object-cover"
        />
        <StatusBadge
          label={asset.isActive ? "Active" : "Archived"}
          tone={asset.isActive ? "positive" : "neutral"}
        />
      </Card>

      <div className="flex flex-1 flex-col gap-6">
        <Card className="flex flex-col gap-2">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-muted">Filename</dt>
            <dd className="text-text-primary">{asset.fileName}</dd>
            <dt className="text-text-muted">Type</dt>
            <dd className="text-text-primary">{asset.contentType}</dd>
            <dt className="text-text-muted">Size</dt>
            <dd className="text-text-primary">{formatFileSize(asset.fileSizeBytes)}</dd>
            <dt className="text-text-muted">Uploaded by</dt>
            <dd className="text-text-primary">{asset.uploadedByLabel ?? "Unknown"}</dd>
            <dt className="text-text-muted">Created</dt>
            <dd className="text-text-primary">{formatMediaDate(asset.createdAt)}</dd>
            <dt className="text-text-muted">Updated</dt>
            <dd className="text-text-primary">{formatMediaDate(asset.updatedAt)}</dd>
          </dl>
        </Card>

        {canManage ? (
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <FormField
              label="Title"
              htmlFor="media-title"
              hint="Optional. Shown in the library grid instead of the filename."
            >
              <input
                id="media-title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setSaved(false);
                }}
                autoComplete="off"
                className={`${ADMIN_FIELD_CLASS} min-h-11`}
              />
            </FormField>
            <FormField
              label="Alt text"
              htmlFor="media-alt-text"
              hint="Optional. Describes the image for screen readers."
            >
              <input
                id="media-alt-text"
                value={altText}
                onChange={(event) => {
                  setAltText(event.target.value);
                  setSaved(false);
                }}
                autoComplete="off"
                className={`${ADMIN_FIELD_CLASS} min-h-11`}
              />
            </FormField>

            {error ? (
              <p role="alert" className="text-sm text-status-warning">
                {error}
              </p>
            ) : null}
            {saved ? (
              <p className="text-sm text-status-success">Saved.</p>
            ) : null}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {asset.isActive ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleArchive()}
                  disabled={archiving}
                >
                  {archiving ? "Archiving…" : "Archive"}
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
