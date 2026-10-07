"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  groupAdminNavItems,
  isNavItemActive,
  type AdminNavGroup,
  type AdminNavItem,
} from "@/lib/admin/nav";
import { IconChevronDown, IconHome, NAV_ICONS } from "@/components/centerivo/Icons";

// The module navigation, shared by the desktop sidebar and the mobile
// drawer. WHICH items exist is decided server-side from the capability map
// (adminNavItems); this component only arranges them for display:
//   - primary items: the daily operating modules, always visible;
//   - collapsible groups: lower-frequency areas behind a quiet heading, open
//     automatically when they hold the current page;
//   - footer items (Administration), rendered by <AdminNavFooter>.
// It also adds active-state highlighting (client, via usePathname) and
// preserves the current ?location context on every link.
function useNavModel(items: AdminNavItem[]) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = searchParams.get("location");
  const suffix = location ? `?location=${encodeURIComponent(location)}` : "";
  return { pathname, suffix, groups: groupAdminNavItems(items) };
}

function NavLink({
  item,
  active,
  suffix,
  collapsed,
  dense = false,
  onNavigate,
}: {
  item: AdminNavItem;
  active: boolean;
  suffix: string;
  collapsed: boolean;
  dense?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = NAV_ICONS[item.key] ?? IconHome;
  return (
    <Link
      href={`${item.href}${suffix}`}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={`group flex items-center gap-3 rounded-lg transition-colors ${
        collapsed ? "mx-auto h-10 w-10 justify-center" : "px-3"
      } ${collapsed ? "" : dense ? "h-9 text-[0.8125rem]" : "h-10 text-sm"} ${
        active
          ? "bg-accent-soft font-medium text-text-primary"
          : "text-text-secondary hover:bg-black/[0.045] hover:text-text-primary"
      }`}
    >
      <Icon
        className={`h-[18px] w-[18px] ${
          active
            ? "text-accent"
            : "text-text-muted group-hover:text-text-secondary"
        }`}
      />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="truncate">{item.label}</span>
      )}
    </Link>
  );
}

function CollapsibleGroup({
  group,
  pathname,
  suffix,
  collapsed,
  onNavigate,
}: {
  group: AdminNavGroup;
  pathname: string;
  suffix: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const hasActive = group.items.some((item) => isNavItemActive(item, pathname));
  // null = follow the current page; once the person toggles, respect that.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? hasActive;
  const listId = `nav-group-${group.key}`;

  if (collapsed) {
    return (
      <ul className="flex flex-col gap-0.5">
        {group.items.map((item) => (
          <li key={item.key}>
            <NavLink
              item={item}
              active={isNavItemActive(item, pathname)}
              suffix={suffix}
              collapsed
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setChosen(!open)}
        className="group flex h-9 w-full items-center justify-between rounded-lg px-3 text-[0.8125rem] font-medium text-text-muted transition-colors hover:bg-black/[0.045] hover:text-text-secondary"
      >
        <span className="flex items-center gap-2">
          {group.label}
          {!open && hasActive ? (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-accent"
            />
          ) : null}
        </span>
        <IconChevronDown
          className={`h-3.5 w-3.5 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
      </button>
      {open ? (
        <ul id={listId} className="mt-0.5 flex flex-col gap-0.5">
          {group.items.map((item) => (
            <li key={item.key}>
              <NavLink
                item={item}
                active={isNavItemActive(item, pathname)}
                suffix={suffix}
                collapsed={false}
                dense
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AdminNav({
  items,
  collapsed = false,
  onNavigate,
}: {
  items: AdminNavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { pathname, suffix, groups } = useNavModel(items);
  const primary = groups.filter((g) => g.tier === "primary");
  const collapsible = groups.filter((g) => g.tier === "collapsible");

  return (
    <nav aria-label="Admin" className="flex flex-col gap-4">
      {primary.map((group) => (
        <ul key={group.key} className="flex flex-col gap-0.5">
          {group.items.map((item) => (
            <li key={item.key}>
              <NavLink
                item={item}
                active={isNavItemActive(item, pathname)}
                suffix={suffix}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      ))}
      {collapsible.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-black/[0.06] pt-3">
          {collapsible.map((group) => (
            <CollapsibleGroup
              key={group.key}
              group={group}
              pathname={pathname}
              suffix={suffix}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </nav>
  );
}

// Pinned items (Administration) shown just above the account area.
export function AdminNavFooter({
  items,
  collapsed = false,
  onNavigate,
}: {
  items: AdminNavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { pathname, suffix, groups } = useNavModel(items);
  const footer = groups.filter((g) => g.tier === "footer");
  if (footer.length === 0) return null;
  return (
    <nav aria-label="Workspace administration">
      <ul className="flex flex-col gap-0.5">
        {footer.flatMap((group) =>
          group.items.map((item) => (
            <li key={item.key}>
              <NavLink
                item={item}
                active={isNavItemActive(item, pathname)}
                suffix={suffix}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </li>
          )),
        )}
      </ul>
    </nav>
  );
}
