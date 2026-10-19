import Link from "next/link";

// SC4e — a row of filter links for the onboarding reports. The current one
// is marked for assistive technology (aria-current), not only by colour.
export function FilterLinks<T extends string>({
  label,
  options,
  current,
  hrefFor,
  labels,
}: {
  label: string;
  options: readonly T[];
  current: T;
  hrefFor: (value: T) => string;
  labels: Record<T, string>;
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = option === current;
          return (
            <li key={option}>
              <Link
                href={hrefFor(option)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                  active
                    ? "border-accent bg-accent text-accent-contrast"
                    : "border-border-default text-text-primary hover:bg-surface-subtle"
                }`}
              >
                {labels[option]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ESP-03 PR 5 — `area` names what the permission is for (default: the
// onboarding reports).
export function NoPermissionPanel({
  permission,
  area = "Onboarding oversight",
}: {
  permission: string;
  area?: string;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-6"
    >
      <h2 className="text-base font-semibold text-text-primary">Access denied</h2>
      <p className="max-w-prose text-sm text-text-secondary">
        {area} needs the {permission} permission. Ask a CENTERIVO
        administrator to grant it.
      </p>
    </div>
  );
}
