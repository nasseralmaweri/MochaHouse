// Milestone 9E — deterministic, filesystem-safe export filenames.
// `mocha-house-<report-slug>_<startDate>_to_<endDate>[_<location-slug>].csv`

// Lowercase, strip diacritics from Latin characters, collapse anything
// that isn't a-z/0-9 into a single hyphen, trim leading/trailing hyphens.
// A name with no ASCII-representable characters at all (e.g. entirely
// non-Latin script) slugifies to an empty string — callers must fall back
// to omitting the segment rather than emitting a broken filename.
export function slugifyForFilename(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildExportFilename(
  reportSlug: string,
  startDate: string,
  endDate: string,
  locationName?: string | null,
): string {
  const slug = locationName ? slugifyForFilename(locationName) : '';
  const locationSuffix = slug ? `_${slug}` : '';
  return `mocha-house-${reportSlug}_${startDate}_to_${endDate}${locationSuffix}.csv`;
}
