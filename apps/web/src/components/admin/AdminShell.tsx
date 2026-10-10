"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type {
  InternalBusinessSummary,
  InternalUserProfile,
  LocationSummary,
} from "@mocha-house/contracts";
import type { AdminNavItem } from "@/lib/admin/nav";
import type { AdminCapabilities } from "@/lib/admin/capabilities";
import {
  locationContextValue,
  resolveLocationContext,
} from "@/lib/admin/location-context";
import { CenterivoMark } from "@/components/centerivo/Wordmark";
import { IconMenuBars } from "@/components/centerivo/Icons";
import { AdminContextProvider } from "./AdminContext";
import { AdminSidebar } from "./AdminSidebar";
import { MobileNav } from "./MobileNav";
import { MobileTabBar } from "./MobileTabBar";
import { ScopeSwitcher } from "./ContextSwitcher";

const COLLAPSE_STORAGE_KEY = "centerivo.sidebar.collapsed";
const COLLAPSE_EVENT = "centerivo:sidebar-preference";

// Sidebar collapse: an explicit choice is remembered per browser; with no
// choice, laptop-width screens start collapsed to give content room. The
// server render (and hydration) is always expanded; this settles right after.
let memoryPreference: "0" | "1" | null = null;

function subscribeSidebarPreference(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(COLLAPSE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(COLLAPSE_EVENT, callback);
  };
}

function readSidebarCollapsed(): boolean {
  let stored: string | null = memoryPreference;
  if (stored === null) {
    try {
      stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    } catch {
      // storage unavailable — fall back to the width heuristic
    }
  }
  if (stored === "1" || stored === "0") return stored === "1";
  return !window.matchMedia("(min-width: 1280px)").matches;
}

function writeSidebarCollapsed(next: boolean) {
  memoryPreference = next ? "1" : "0";
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, memoryPreference);
  } catch {
    // not persisted; the toggle still works for this visit
  }
  window.dispatchEvent(new Event(COLLAPSE_EVENT));
}

// The CENTERIVO Admin shell. Rendered by the SERVER layout, which passes the
// already-resolved session, active business and authorization summary as
// props. This client component owns only interaction state (mobile drawer,
// sidebar collapse) and the URL-dependent location-context resolution, and
// provides AdminContext to every Admin page.
//
// Layout follows Business -> Scope -> Work: a deep-navy sidebar (identity,
// business, modules, account) beside the workspace, whose compact header
// names the business and carries the operating scope (Company-wide or one
// location). Below `lg` the sidebar becomes a drawer opened from the header;
// on phones a bottom tab bar adds the daily modules.
export function AdminShell({
  user,
  business,
  businesses,
  capabilities,
  isCorporate,
  locations,
  navItems,
  cookieLocationId,
  children,
}: {
  user: InternalUserProfile;
  business: InternalBusinessSummary;
  businesses: InternalBusinessSummary[];
  capabilities: AdminCapabilities;
  isCorporate: boolean;
  locations: LocationSummary[];
  navItems: AdminNavItem[];
  cookieLocationId: string | null;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const collapsed = useSyncExternalStore(
    subscribeSidebarPreference,
    readSidebarCollapsed,
    () => false,
  );

  const toggleCollapsed = () => writeSidebarCollapsed(!collapsed);

  const searchParams = useSearchParams();
  const locationContext = resolveLocationContext({
    authorizedLocations: locations,
    isCorporate,
    urlLocationId: searchParams.get("location"),
    cookieLocationId,
  });
  const currentLocationValue = locationContextValue(locationContext);

  const sidebarProps = { user, business, businesses, navItems };

  return (
    <AdminContextProvider
      user={user}
      capabilities={capabilities}
      isCorporate={isCorporate}
      locations={locations}
      locationContext={locationContext}
    >
      <a
        href="#admin-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-text-primary focus:outline focus:outline-2 focus:outline-focus"
      >
        Skip to content
      </a>

      <div className="centerivo cx-shell flex min-h-dvh">
        <aside
          aria-label="Workspace"
          className={`cx-dark sticky top-0 hidden h-dvh shrink-0 transition-[width] duration-200 ease-out lg:block ${
            collapsed
              ? "w-[var(--cx-sidebar-width-collapsed)]"
              : "w-[var(--cx-sidebar-width)]"
          }`}
        >
          <AdminSidebar
            {...sidebarProps}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-1.5 border-b border-border-default bg-surface-page/90 px-2 backdrop-blur sm:gap-2 sm:px-4 lg:h-16 lg:px-8">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-expanded={drawerOpen}
              aria-haspopup="dialog"
              aria-label="Open navigation"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-primary transition-colors hover:bg-surface-subtle lg:hidden"
            >
              <IconMenuBars className="h-5 w-5" />
            </button>
            <Link
              href="/admin"
              aria-label="CENTERIVO home"
              className="hidden h-11 w-9 shrink-0 items-center justify-center rounded-lg sm:flex lg:hidden"
            >
              <CenterivoMark className="h-6 w-6" />
            </Link>
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <span className="sr-only">Business: </span>
              <span className="truncate font-semibold text-text-primary">
                {business.name}
              </span>
              <span aria-hidden="true" className="text-text-muted">
                /
              </span>
            </p>
            <div className="flex min-w-0 max-w-[62%] items-center sm:max-w-none">
              <ScopeSwitcher
                locations={locations}
                isCorporate={isCorporate}
                currentLocationValue={currentLocationValue}
              />
            </div>
          </header>

          <main
            id="admin-content"
            className="min-w-0 flex-1 bg-surface-page pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0"
          >
            {children}
          </main>
        </div>

        <MobileTabBar
          items={navItems}
          menuOpen={drawerOpen}
          onOpenMenu={() => setDrawerOpen(true)}
        />

        {/* Inside .centerivo so the drawer inherits the platform tokens. */}
        <MobileNav
          open={drawerOpen}
          onClose={closeDrawer}
          triggerRef={menuButtonRef}
        >
          <AdminSidebar {...sidebarProps} onNavigate={closeDrawer} />
        </MobileNav>
      </div>
    </AdminContextProvider>
  );
}
