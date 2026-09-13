// Plain-language presentation helpers for Admin → Media (Milestone 8F;
// mediaAssetDisplayTitle added in 8I). Read-only: the API is the authority
// for every value.

// title (Milestone 8I) is optional — falls back to the original filename
// wherever a single display label is needed (grid cards, picker previews).
export function mediaAssetDisplayTitle(asset: {
  title: string | null;
  fileName: string;
}): string {
  return asset.title && asset.title.trim().length > 0
    ? asset.title
    : asset.fileName;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A short "Jan 5, 2026" date for grid rows.
export function formatMediaDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
