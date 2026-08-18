export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
        {title}
      </h1>
      {subtitle ? (
        <p className="text-sm text-text-secondary">{subtitle}</p>
      ) : null}
    </header>
  );
}
