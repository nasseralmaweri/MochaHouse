"use client";

import type {
  InternalBusinessSummary,
  InternalUserProfile,
  LocationSummary,
} from "@mocha-house/contracts";
import type { AdminNavItem } from "@/lib/admin/nav";
import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import { CenterivoMark } from "@/components/centerivo/Wordmark";
import { IconSidebar } from "@/components/centerivo/Icons";
import { AdminNav, AdminNavFooter } from "./AdminNav";
import { AccountMenu } from "./AccountMenu";
import { ContextSwitcher } from "./ContextSwitcher";

const collapseButton =
  "flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/[0.05] hover:text-text-secondary";

// The sidebar's content, shared verbatim by the desktop sidebar (which may
// be collapsed to an icon rail) and the mobile drawer (never collapsed).
// Top to bottom: platform identity, Business -> Location context, module
// navigation (the only scrolling region), pinned Administration, account.
// The sidebar has no surface of its own: it sits directly on the shell
// background, and the workspace is the inset panel beside it.
export function AdminSidebar({
  user,
  business,
  businesses,
  locations,
  isCorporate,
  currentLocationValue,
  navItems,
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
}: {
  user: InternalUserProfile;
  business: InternalBusinessSummary;
  businesses: InternalBusinessSummary[];
  locations: LocationSummary[];
  isCorporate: boolean;
  currentLocationValue: string;
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
            : "justify-between px-5 pb-3 pt-5"
        }`}
      >
        {collapsed ? <CenterivoMark /> : <CenterivoWordmark />}
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

      <div className={collapsed ? "px-2 pb-3 pt-2" : "px-3 pb-5 pt-2"}>
        <ContextSwitcher
          business={business}
          businesses={businesses}
          locations={locations}
          isCorporate={isCorporate}
          currentLocationValue={currentLocationValue}
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
        className={`flex flex-col gap-1 border-t border-black/[0.06] py-3 ${
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
