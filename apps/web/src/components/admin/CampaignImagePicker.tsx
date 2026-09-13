"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminMediaAsset } from "@mocha-house/contracts";
import {
  listAdminMediaAssetsFromBrowser,
  uploadMediaAssetFromBrowser,
} from "@/lib/api-client";
import { Card } from "@/components/Card";
import { Button } from "./Button";

// The current selection resolves to one of these states — see
// HeroImagePicker (Milestone 8F), whose logic this mirrors for Admin →
// Marketing → Campaign creative image (Milestone 8G).
type Resolution =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "found"; asset: AdminMediaAsset }
  | { status: "unavailable" }
  | { status: "forbidden" };

// Bounded pagination walk over the existing admin media list endpoint —
// reused as-is, no new Media API.
const MAX_LOOKUP_PAGES = 20;

async function findAssetById(
  mediaAssetId: string,
): Promise<AdminMediaAsset | "unavailable" | "forbidden"> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    const result = await listAdminMediaAssetsFromBrowser({ cursor });
    if (result.outcome === "forbidden") {
      return "forbidden";
    }
    if (result.outcome !== "success") {
      return "unavailable";
    }
    const match = result.data.assets.find((asset) => asset.id === mediaAssetId);
    if (match) {
      return match;
    }
    if (!result.data.nextCursor) {
      return "unavailable";
    }
    cursor = result.data.nextCursor;
  }
  return "unavailable";
}

// Admin → Marketing → Campaign → creative image (Milestone 8G). Shows the
// current selection, an expandable panel to choose from the media library
// (requires `media.view`-equivalent visibility — fetched on open), an
// "Upload new" action gated separately on `canUpload` (`media.manage`,
// distinct from `marketing.manage`), and a "Clear" action. Only an image id
// is ever stored on the campaign; this component resolves ids to
// thumbnails purely for display.
export function CampaignImagePicker({
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
  const [resolution, setResolution] = useState<Resolution>(
    value ? { status: "loading" } : { status: "idle" },
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!value) {
      setResolution({ status: "idle" });
      return;
    }
    if (resolution.status === "found" && resolution.asset.id === value) {
      return;
    }
    let cancelled = false;
    setResolution({ status: "loading" });
    void findAssetById(value).then((result) => {
      if (cancelled) {
        return;
      }
      setResolution(
        result === "unavailable" || result === "forbidden"
          ? { status: result }
          : { status: "found", asset: result },
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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
      setResolution({ status: "found", asset: result.asset });
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

  function select(asset: AdminMediaAsset) {
    setResolution({ status: "found", asset });
    onChange(asset.id);
    setOpen(false);
  }

  function clear() {
    setResolution({ status: "idle" });
    onChange(null);
  }

  const selectedAsset = resolution.status === "found" ? resolution.asset : null;

  return (
    <div className="flex flex-col gap-2">
      <Card className="flex items-center gap-3">
        {selectedAsset ? (
          // eslint-disable-next-line @next/next/no-img-element -- Admin-only preview thumbnail.
          <img
            src={selectedAsset.publicUrl}
            alt={selectedAsset.fileName}
            className="h-16 w-16 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-surface-subtle text-xs text-text-muted">
            No image
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm text-text-primary">
            {selectedAsset
              ? selectedAsset.fileName
              : resolution.status === "loading"
                ? "Loading selected image…"
                : resolution.status === "unavailable"
                  ? "Selected image is unavailable"
                  : resolution.status === "forbidden"
                    ? "An image is selected — you don't have permission to preview it"
                    : "No image selected"}
          </span>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button type="button" variant="secondary" onClick={() => void openPicker()}>
            Choose image
          </Button>
          {value ? (
            <Button type="button" variant="secondary" onClick={clear}>
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
                    onClick={() => select(asset)}
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
