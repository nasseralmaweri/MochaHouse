"use client";

import { useRef, useState } from "react";
import type { AdminMediaAsset } from "@mocha-house/contracts";
import {
  listAdminMediaAssetsFromBrowser,
  uploadMediaAssetFromBrowser,
} from "@/lib/api-client";
import { Card } from "@/components/Card";
import { Button } from "./Button";

// Admin → Content → Home → Hero background image (Milestone 8F). Shows the
// current selection, an expandable panel to choose from the media library
// (requires `media.view` to browse — fetched on open, not on every
// render), an "Upload new" action gated separately on `canUpload`
// (`media.manage` — distinct from the surrounding form's `cms.manage`),
// and a "Clear" action. Only an image id is ever stored in Home's content;
// this component resolves ids to thumbnails purely for display.
export function HeroImagePicker({
  value,
  onChange,
  canUpload,
}: {
  value: string | null;
  onChange: (mediaAssetId: string | null) => void;
  canUpload: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<AdminMediaAsset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = assets?.find((asset) => asset.id === value) ?? null;

  async function openPicker() {
    setOpen(true);
    if (assets !== null) {
      return;
    }
    setLoading(true);
    setError(null);
    const result = await listAdminMediaAssetsFromBrowser({});
    setLoading(false);
    if (result.outcome === "success") {
      setAssets(result.data.assets);
      return;
    }
    setAssets([]);
    setError(
      result.outcome === "forbidden"
        ? "You don't have permission to browse the media library."
        : result.message,
    );
  }

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
      setAssets((prev) => [result.asset, ...(prev ?? [])]);
      onChange(result.asset.id);
      setOpen(false);
      return;
    }
    setError(
      result.outcome === "forbidden"
        ? "You no longer have permission to upload images."
        : result.message,
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Card className="flex items-center gap-3">
        {selected ? (
          // eslint-disable-next-line @next/next/no-img-element -- Admin-only preview thumbnail.
          <img
            src={selected.publicUrl}
            alt={selected.fileName}
            className="h-16 w-16 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-surface-subtle text-xs text-text-muted">
            No image
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm text-text-primary">
            {selected ? selected.fileName : value ? value : "No background image selected"}
          </span>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button type="button" variant="secondary" onClick={() => void openPicker()}>
            Choose image
          </Button>
          {value ? (
            <Button type="button" variant="secondary" onClick={() => onChange(null)}>
              Clear
            </Button>
          ) : null}
        </div>
      </Card>

      {open ? (
        <Card className="flex flex-col gap-3">
          {canUpload ? (
            <div className="flex items-center gap-3">
              <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleUpload}
                className="hidden"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Upload new image"}
              </Button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-status-warning">
              {error}
            </p>
          ) : null}

          {loading ? (
            <p className="text-sm text-text-secondary">Loading…</p>
          ) : assets && assets.length > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(asset.id);
                      setOpen(false);
                    }}
                    className={`block w-full overflow-hidden rounded-lg border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                      asset.id === value ? "border-status-success" : "border-transparent"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- Admin-only picker thumbnail. */}
                    <img
                      src={asset.publicUrl}
                      alt={asset.fileName}
                      className="aspect-square w-full object-cover"
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : assets && assets.length === 0 && !error ? (
            <p className="text-sm text-text-secondary">
              No images yet. Upload one to use it here.
            </p>
          ) : null}

          <Button type="button" variant="secondary" onClick={() => setOpen(false)} className="self-start">
            Close
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
