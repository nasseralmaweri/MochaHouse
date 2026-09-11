"use client";

import { useRef, useState } from "react";
import type { AdminMediaAsset } from "@mocha-house/contracts";
import {
  deactivateMediaAssetFromBrowser,
  uploadMediaAssetFromBrowser,
} from "@/lib/api-client";
import { formatFileSize, formatMediaDate } from "@/lib/admin/media";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { AdminEmptyState, AdminErrorState } from "./states";

// Admin → Media (Milestone 8F). A simple V1 grid — no folders, tags,
// search, cropping, or bulk actions. Upload and deactivate render only
// under `canManage` (the page has already checked `media.manage`); the API
// re-checks. Deactivating an image still used as Home's hero background
// returns 409 — shown here as a clear, specific error, not a generic one.
export function MediaLibraryGrid({
  initial,
  canManage,
}: {
  initial: AdminMediaAsset[];
  canManage: boolean;
}) {
  const [assets, setAssets] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setError(null);
    setUploading(true);
    const result = await uploadMediaAssetFromBrowser(file);
    setUploading(false);
    if (result.outcome === "success") {
      setAssets((prev) => [result.asset, ...prev]);
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You no longer have permission to upload images."
        : result.message,
    );
  }

  async function handleDeactivate(assetId: string) {
    setError(null);
    setPendingId(assetId);
    const result = await deactivateMediaAssetFromBrowser(assetId);
    setPendingId(null);
    if (result.outcome === "success") {
      setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      return;
    }
    setError(
      result.outcome === "conflict"
        ? result.message
        : result.outcome === "forbidden"
          ? "You no longer have permission to remove images."
          : result.outcome === "not-found"
            ? "This image no longer exists."
            : result.message,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleUpload}
            className="hidden"
          />
          <Button
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "Upload image"}
          </Button>
          <span className="text-xs text-text-muted">
            JPEG, PNG, or WebP. Up to 5 MB.
          </span>
        </div>
      ) : null}

      {error ? <AdminErrorState description={error} /> : null}

      {assets.length === 0 ? (
        <AdminEmptyState
          title="No images yet"
          description="Upload an image to make it available for CMS pages."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {assets.map((asset) => (
            <li key={asset.id}>
              <Card className="flex flex-col gap-2 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- Admin-only library thumbnail; host is operator-configured, not a next/image remote pattern concern here. */}
                <img
                  src={asset.publicUrl}
                  alt={asset.fileName}
                  className="aspect-square w-full rounded-lg object-cover"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="truncate text-xs font-medium text-text-primary">
                    {asset.fileName}
                  </span>
                  <span className="text-xs text-text-muted">
                    {formatFileSize(asset.fileSizeBytes)} · {formatMediaDate(asset.createdAt)}
                  </span>
                </div>
                {canManage ? (
                  <Button
                    variant="secondary"
                    onClick={() => void handleDeactivate(asset.id)}
                    disabled={pendingId === asset.id}
                    className="text-xs"
                  >
                    {pendingId === asset.id ? "Removing…" : "Remove"}
                  </Button>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
