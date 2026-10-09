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
  CORPORATE_LOCATION_VALUE,
  locationContextValue,
  resolveLocationContext,
} from "@/lib/admin/location-context";
import { CenterivoMark } from "@/components/centerivo/Wordmark";
import {
  IconAllLocations,
  IconChevronsUpDown,
  IconMenuBars,
} from "@/components/centerivo/Icons";
import { AdminContextProvider } from "./AdminContext";
import { AdminSidebar } from "./AdminSidebar";
import { MobileNav } from "./MobileNav";

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
// Layout: a fixed-height sidebar (identity, Business -> Location context,
// modules, account) beside a single scrolling content column. There is
// deliberately NO desktop top bar — context lives in the sidebar, so the
// page gets the full height. Below `lg` the sidebar becomes a drawer and a
// slim top bar appears carrying the menu button and the current context.
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
  const currentLocationLabel =
    locationContext.kind === "corporate"
      ? "Company-wide"
      : locationContext.kind === "location"
        ? locationContext.location.name
        : null;

  const sidebarProps = {
    user,
    business,
    businesses,
    locations,
    isCorporate,
    currentLocationValue,
    navItems,
  };

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
          className={`sticky top-0 hidden h-dvh shrink-0 transition-[width] duration-200 ease-out lg:block ${
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

        <div className="flex min-w-0 flex-1 flex-col lg:py-2 lg:pr-2">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border-default bg-surface-sidebar/90 px-3 backdrop-blur lg:hidden">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-expanded={drawerOpen}
              className="flex h-10 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-subtle"
            >
              <IconMenuBars />
              Menu
            </button>
            <Link
              href="/admin"
              aria-label="CENTERIVO home"
              className="flex items-center rounded-lg px-1"
            >
              <CenterivoMark className="h-6 w-6" />
            </Link>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={`Business ${business.name}${
                currentLocationLabel ? `, location ${currentLocationLabel}` : ""
              }. Change in menu`}
              className="ml-auto flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-subtle"
            >
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-sm font-semibold text-text-primary">
                  {business.name}
                </span>
                {currentLocationLabel ? (
                  <span className="flex items-center gap-1 truncate text-xs text-text-muted">
                    {currentLocationValue === CORPORATE_LOCATION_VALUE ? (
                      <IconAllLocations className="h-3 w-3" />
                    ) : null}
                    {currentLocationLabel}
                  </span>
                ) : null}
              </span>
              <IconChevronsUpDown className="h-4 w-4 text-text-muted" />
            </button>
          </header>

          <main
            id="admin-content"
            className="min-w-0 flex-1 bg-surface-page lg:rounded-2xl lg:border lg:border-border-default"
          >
            {children}
          </main>
        </div>

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
