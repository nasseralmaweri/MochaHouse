// SC1b — the platform console's building blocks. A metric is shown only
// when a real source exists; otherwise the card says so plainly instead of
// showing a number.

export function PlatformPageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
        {title}
      </h1>
      {description ? (
        <p className="max-w-2xl text-sm text-text-secondary">{description}</p>
      ) : null}
    </div>
  );
}

export function PlatformCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5"
    >
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

// A metric whose data source is not built yet. Never shows a number.
export function UnavailableMetric({
  title,
  reason,
}: {
  title: string;
  reason: string;
}) {
  return (
    <PlatformCard title={title}>
      <p className="text-2xl font-semibold text-text-muted" aria-hidden="true">
        —
      </p>
      <p className="text-sm text-text-secondary">
        <span className="font-medium text-text-primary">Not available yet.</span>{" "}
        {reason}
      </p>
    </PlatformCard>
  );
}

export function PlatformEmptyState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-2xl border border-dashed border-border-default bg-surface-card p-6">
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      <div className="text-sm text-text-secondary">{children}</div>
    </div>
  );
}
