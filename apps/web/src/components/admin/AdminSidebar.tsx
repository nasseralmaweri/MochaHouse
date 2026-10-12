"use client";

import type {
  InternalBusinessSummary,
  InternalUserProfile,
} from "@mocha-house/contracts";
import type { AdminNavItem } from "@/lib/admin/nav";
import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import { CenterivoMark } from "@/components/centerivo/Wordmark";
import { IconSidebar } from "@/components/centerivo/Icons";
import { AdminNav, AdminNavFooter } from "./AdminNav";
import { AccountMenu } from "./AccountMenu";
import { BusinessSwitcher } from "./ContextSwitcher";

const collapseButton =
  "flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-subtle hover:text-text-primary";

// The sidebar's content, shared verbatim by the desktop sidebar (which may
// be collapsed to an icon rail) and the mobile drawer (never collapsed).
// Top to bottom: platform identity, business, module navigation (the only
// scrolling region), pinned Administration, account. It renders inside a
// `.cx-dark` region, so the semantic tokens it uses resolve to the navy
// palette; the operating scope lives in the workspace header.
export function AdminSidebar({
  user,
  business,
  businesses,
  navItems,
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
}: {
  user: InternalUserProfile;
  business: InternalBusinessSummary;
  businesses: InternalBusinessSummary[];
  navItems: AdminNavItem[];
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex items-center ${
          collapsed
            ? "flex-col gap-2 px-2 pb-1 pt-4"
            : "justify-between py-4 pl-5 pr-3"
        }`}
      >
        {collapsed ? (
          <CenterivoMark className="h-7 w-7" />
        ) : (
          <CenterivoWordmark />
        )}
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={collapseButton}
          >
            <IconSidebar />
          </button>
        ) : null}
      </div>

      <div className={collapsed ? "px-2 pb-3 pt-2" : "px-3 pb-4"}>
        <BusinessSwitcher
          business={business}
          businesses={businesses}
          collapsed={collapsed}
        />
      </div>

      <div
        className={`cx-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 ${
          collapsed ? "px-2" : "px-3"
        }`}
      >
        <AdminNav
          items={navItems}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>

      <div
        className={`flex flex-col gap-1 border-t border-border-default py-3 ${
          collapsed ? "px-2" : "px-3"
        }`}
      >
        <AdminNavFooter
          items={navItems}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
        <AccountMenu user={user} business={business} collapsed={collapsed} />
      </div>
    </div>
  );
}
