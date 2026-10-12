"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { isNavItemActive, type AdminNavItem } from "@/lib/admin/nav";
import {
  IconHome,
  IconMenuBars,
  NAV_ICONS,
} from "@/components/centerivo/Icons";

// Daily modules, in the order the phone tab bar prefers them. Only items the
// server already granted (adminNavItems) can appear; anything missing is
// back-filled from the rest of the permitted list so a location-scoped user
// still gets a useful bar.
const TAB_PREFERENCE = ["dashboard", "orders", "operations", "locations"];
const MAX_TABS = 4;

function pickTabs(items: AdminNavItem[]): AdminNavItem[] {
  const usable = items.filter((item) => item.key !== "administration");
  const picked = TAB_PREFERENCE.flatMap((key) =>
    usable.filter((item) => item.key === key),
  );
  for (const item of usable) {
    if (picked.length >= MAX_TABS) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.slice(0, MAX_TABS);
}

// The phone-only bottom navigation: up to four permitted daily modules plus
// "More", which opens the full navigation drawer. Links keep the current
// ?location= scope, exactly like the sidebar.
export function MobileTabBar({
  items,
  onOpenMenu,
  menuOpen,
}: {
  items: AdminNavItem[];
  onOpenMenu: () => void;
  menuOpen: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = searchParams.get("location");
  const suffix = location ? `?location=${encodeURIComponent(location)}` : "";
  const tabs = pickTabs(items);
  const tabActive = tabs.some((item) => isNavItemActive(item, pathname));

  const tabClass =
    "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 text-[0.6875rem] font-medium transition-colors";
  const activeBar =
    "before:absolute before:top-0 before:left-1/2 before:h-[3px] before:w-8 before:-translate-x-1/2 before:rounded-b-full before:bg-accent";

  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border-default bg-surface-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="flex">
        {tabs.map((item) => {
          const active = isNavItemActive(item, pathname);
          const Icon = NAV_ICONS[item.key] ?? IconHome;
          return (
            <li key={item.key} className="flex min-w-0 flex-1">
              <Link
                href={`${item.href}${suffix}`}
                aria-current={active ? "page" : undefined}
                className={`${tabClass} ${
                  active
                    ? `text-text-primary ${activeBar}`
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpenMenu}
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            className={`${tabClass} ${
              tabActive
                ? "text-text-muted hover:text-text-primary"
                : `text-text-primary ${activeBar}`
            }`}
          >
            <IconMenuBars className="h-5 w-5" />
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}
