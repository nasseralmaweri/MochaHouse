"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type {
  InternalUserProfile,
  LocationSummary,
} from "@mocha-house/contracts";
import type { AdminNavItem } from "@/lib/admin/nav";
import type { AdminCapabilities } from "@/lib/admin/capabilities";
import {
  locationContextValue,
  resolveLocationContext,
} from "@/lib/admin/location-context";
import { AdminContextProvider } from "./AdminContext";
import { AdminNav } from "./AdminNav";
import { AccountMenu } from "./AccountMenu";
import { MobileNav } from "./MobileNav";
import { LocationSwitcher } from "./LocationSwitcher";

// The shared Admin shell. Rendered by the SERVER layout, which passes the
// already-resolved session + authorization summary as props. This client
// component owns only interaction state (mobile drawer) and the
// URL-dependent location-context resolution, and provides AdminContext to
// every Admin page.
export function AdminShell({
  user,
  capabilities,
  isCorporate,
  locations,
  navItems,
  cookieLocationId,
  children,
}: {
  user: InternalUserProfile;
  capabilities: AdminCapabilities;
  isCorporate: boolean;
  locations: LocationSummary[];
  navItems: AdminNavItem[];
  cookieLocationId: string | null;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const searchParams = useSearchParams();
  const locationContext = resolveLocationContext({
    authorizedLocations: locations,
    isCorporate,
    urlLocationId: searchParams.get("location"),
    cookieLocationId,
  });

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
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-surface-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-text-primary focus:outline focus:outline-2 focus:outline-focus"
      >
        Skip to content
      </a>

      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 border-b border-border-default bg-surface-card">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-6">
            <div className="flex items-center gap-2">
              <button
                ref={menuButtonRef}
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
                aria-expanded={drawerOpen}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
              >
                <span aria-hidden="true">☰</span>
              </button>
              <Link
                href="/admin"
                className="whitespace-nowrap text-sm font-semibold tracking-tight text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                Mocha House <span className="text-text-muted">Admin</span>
              </Link>
            </div>
            <div className="order-3 flex w-full min-w-0 items-center justify-between gap-3 sm:order-none sm:w-auto sm:justify-end">
              <div className="min-w-0">
                <LocationSwitcher
                  locations={locations}
                  isCorporate={isCorporate}
                  currentValue={locationContextValue(locationContext)}
                />
              </div>
              <AccountMenu user={user} />
            </div>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-7xl flex-1">
          <aside className="hidden w-56 shrink-0 border-r border-border-default px-3 py-6 lg:block">
            <AdminNav items={navItems} />
          </aside>

          <main id="admin-content" className="min-w-0 flex-1">
            {children}
          </main>
        </div>
      </div>

      <MobileNav
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={navItems}
        triggerRef={menuButtonRef}
      />
    </AdminContextProvider>
  );
}
