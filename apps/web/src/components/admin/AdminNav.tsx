"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { isNavItemActive, type AdminNavItem } from "@/lib/admin/nav";

// The nav list, shared by the desktop sidebar and the mobile drawer. The
// item list itself is computed server-side (adminNavItems); this component
// only adds active-state highlighting (client, via usePathname) and
// preserves the current ?location context on every link.
export function AdminNav({
  items,
  onNavigate,
}: {
  items: AdminNavItem[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = searchParams.get("location");
  const suffix = location
    ? `?location=${encodeURIComponent(location)}`
    : "";

  return (
    <nav aria-label="Admin" className="flex flex-col gap-1">
      {items.map((item) => {
        const active = isNavItemActive(item, pathname);
        return (
          <Link
            key={item.key}
            href={`${item.href}${suffix}`}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={`flex min-h-11 items-center rounded-xl px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
              active
                ? "bg-surface-subtle text-text-primary"
                : "text-text-secondary hover:bg-surface-subtle hover:text-text-primary"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
