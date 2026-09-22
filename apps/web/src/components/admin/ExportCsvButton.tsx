// Milestone 9E — a plain browser link to a report's CSV export route,
// styled to match Button/ButtonLink's secondary variant. Deliberately a
// raw <a>, never next/link's <Link>: clicking it must trigger a genuine
// browser navigation so the response's `Content-Disposition: attachment`
// header drives native download behavior — Next's client-side router
// would instead try to interpret the CSV bytes as a page navigation.
//
// `href` is built by the caller from the report's CURRENTLY APPLIED
// `filters` prop (never unsaved draft input state), so the downloaded
// file always corresponds to the report currently on screen.
const CLASS =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border-default bg-surface-card px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ExportCsvButton({ href }: { href: string }) {
  return (
    <a href={href} className={CLASS}>
      Export CSV
    </a>
  );
}
