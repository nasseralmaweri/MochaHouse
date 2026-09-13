"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AdminMediaAsset, AdminMediaAssetsResponse } from "@mocha-house/contracts";
import {
  deactivateMediaAssetFromBrowser,
  listAdminMediaAssetsFromBrowser,
  uploadMediaAssetFromBrowser,
} from "@/lib/api-client";
import { formatFileSize, formatMediaDate, mediaAssetDisplayTitle } from "@/lib/admin/media";
import { Card } from "@/components/Card";
import { Button } from "./Button";
import { ADMIN_FIELD_CLASS } from "./form";
import { AdminEmptyState, AdminErrorState } from "./states";

// Admin → Media (Milestone 8F; search + load-more added in 8I). Upload and
// deactivate render only under `canManage` (the page has already checked
// `media.manage`); the API re-checks. Deactivating an image still used as
// Home's hero background or a Campaign's creative returns 409 — shown here
// as a clear, specific error, not a generic one. Each card links to the
// detail screen (title/alt text editing lives there, not in this grid).
export function MediaLibraryGrid({
  initial,
  canManage,
}: {
  initial: AdminMediaAssetsResponse;
  canManage: boolean;
}) {
  const [query, setQuery] = useState("");
  const [assets, setAssets] = useState(initial.assets);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  // Debounced re-search whenever the query changes (empty query -> the
  // full library again), mirroring CustomersBrowser.
  useEffect(() => {
    const id = ++requestId.current;
    const handle = setTimeout(async () => {
      setSearching(true);
      setError(null);
      const result = await listAdminMediaAssetsFromBrowser({ q: query });
      if (id !== requestId.current) {
        return;
      }
      setSearching(false);
      if (result.outcome !== "success") {
        setError(
          result.outcome === "forbidden"
            ? "Your access to the media library was removed."
            : result.message,
        );
        return;
      }
      setAssets(result.data.assets);
      setCursor(result.data.nextCursor);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  async function loadMore() {
    if (!cursor) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    const result = await listAdminMediaAssetsFromBrowser({ q: query, cursor });
    setLoadingMore(false);
    if (result.outcome !== "success") {
      setError(
        result.outcome === "forbidden"
          ? "Your access to the media library was removed."
          : result.message,
      );
      return;
    }
    setAssets((prev) => [...prev, ...result.data.assets]);
    setCursor(result.data.nextCursor);
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by filename or title"
          aria-label="Search media"
          className={`${ADMIN_FIELD_CLASS} min-h-11 sm:max-w-xs`}
        />
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
      </div>

      {error ? <AdminErrorState description={error} /> : null}

      {assets.length === 0 && !searching ? (
        <AdminEmptyState
          title="No images found"
          description={
            query.trim().length > 0
              ? "No image matches that search."
              : "Upload an image to make it available for CMS pages and campaigns."
          }
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {assets.map((asset: AdminMediaAsset) => (
            <li key={asset.id}>
              <Card className="flex flex-col gap-2 p-2">
                <Link href={`/admin/media/${asset.id}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- Admin-only library thumbnail; host is operator-configured, not a next/image remote pattern concern here. */}
                  <img
                    src={asset.publicUrl}
                    alt={asset.altText ?? asset.fileName}
                    className="aspect-square w-full rounded-lg object-cover"
                  />
                </Link>
                <Link
                  href={`/admin/media/${asset.id}`}
                  className="flex flex-col gap-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <span className="truncate text-xs font-medium text-text-primary">
                    {mediaAssetDisplayTitle(asset)}
                  </span>
                  <span className="text-xs text-text-muted">
                    {formatFileSize(asset.fileSizeBytes)} · {formatMediaDate(asset.createdAt)}
                  </span>
                </Link>
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

      {cursor ? (
        <Button
          variant="secondary"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="self-start"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
