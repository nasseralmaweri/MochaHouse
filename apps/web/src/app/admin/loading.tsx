// Shown inside the shell while an Admin route streams in — the sidebar stays
// put, only the content area shows this quiet skeleton.
export default function AdminRouteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10"
    >
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-3">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-surface-subtle" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded bg-surface-subtle" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="h-24 animate-pulse rounded-xl bg-surface-subtle/70" />
        <div className="h-24 animate-pulse rounded-xl bg-surface-subtle/70" />
        <div className="h-24 animate-pulse rounded-xl bg-surface-subtle/70" />
      </div>
    </div>
  );
}
