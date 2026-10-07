import Link from "next/link";

export interface AdminBreadcrumb {
  label: string;
  href?: string;
}

export interface AdminPageContext {
  // "Dearborn Heights" for a concrete location, "All locations" for the
  // corporate context.
  label: string;
  kind: "location" | "corporate";
}

// The reusable Admin page header. Every Admin module renders this instead of
// inventing its own title/action structure.
export function AdminPageHeader({
  title,
  description,
  context,
  breadcrumbs,
  actions,
}: {
  title: string;
  description?: string;
  context?: AdminPageContext;
  breadcrumbs?: AdminBreadcrumb[];
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-text-muted">
            {breadcrumbs.map((crumb, index) => (
              <li key={index} className="flex items-center gap-1">
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="underline underline-offset-2 hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-text-secondary">
                    {crumb.label}
                  </span>
                )}
                {index < breadcrumbs.length - 1 ? (
                  <span aria-hidden="true">/</span>
                ) : null}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-text-primary">
              {title}
            </h1>
            {context ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
                <span aria-hidden="true">
                  {context.kind === "corporate" ? "◆" : "◉"}
                </span>
                <span>
                  {context.kind === "corporate" ? "Context: " : "Location: "}
                  {context.label}
                </span>
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-text-secondary">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
