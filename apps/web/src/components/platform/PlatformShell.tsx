"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PlatformOperatorProfile } from "@mocha-house/contracts";
import { CenterivoWordmark } from "@/components/centerivo/Wordmark";
import {
  IconAdministration,
  IconBusiness,
  IconClose,
  IconHome,
  IconInfo,
  IconMenuBars,
  IconOrders,
  IconPromotions,
  IconReports,
  IconSignOut,
} from "@/components/centerivo/Icons";
import { platformSignOutAction } from "@/lib/platform-auth/actions";
import {
  PLATFORM_NAV_ITEMS,
  isAvailable,
  type PlatformNavKey,
} from "@/lib/platform/nav";

const ICONS: Record<PlatformNavKey, typeof IconHome> = {
  overview: IconHome,
  tenants: IconBusiness,
  plans: IconPromotions,
  subscriptions: IconOrders,
  billing: IconReports,
  support: IconInfo,
  settings: IconAdministration,
};

function PlatformNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Platform" className="flex flex-col gap-0.5 px-3">
      {PLATFORM_NAV_ITEMS.map((item) => {
        const Icon = ICONS[item.key];
        if (!isAvailable(item)) {
          // Not a link and not a control: plain text, with the planned
          // module's purpose available to assistive technology.
          return (
            <p
              key={item.key}
              className="flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm text-text-secondary"
            >
              <Icon className="h-[18px] w-[18px] opacity-60" />
              <span className="flex-1">
                {item.label}
                <span className="sr-only">
                  {" "}
                  — coming soon. {item.description}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="rounded-full border border-border-default px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide"
              >
                Soon
              </span>
            </p>
          );
        }
        const active = pathname === item.href;
        return (
          <Link
            key={item.key}
            href={item.href!}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
              active
                ? "bg-surface-subtle text-text-primary"
                : "text-text-secondary hover:bg-surface-subtle hover:text-text-primary"
            }`}
          >
            <Icon className="h-[18px] w-[18px]" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarContent({
  operator,
  onNavigate,
}: {
  operator: PlatformOperatorProfile;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-1 px-5 pb-5 pt-5">
        <CenterivoWordmark />
        <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Platform Console
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PlatformNav onNavigate={onNavigate} />
      </div>
      <div className="border-t border-border-default px-3 py-4">
        <div className="px-3 pb-3">
          <p className="truncate text-sm font-medium text-text-primary">
            {operator.displayName ?? operator.email}
          </p>
          {operator.displayName ? (
            <p className="truncate text-xs text-text-secondary">{operator.email}</p>
          ) : null}
          <p className="mt-1 text-xs text-text-secondary">Platform operator</p>
        </div>
        <form action={platformSignOutAction}>
          <button
            type="submit"
            className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-subtle hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <IconSignOut className="h-[18px] w-[18px]" />
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

// SC1b — the CENTERIVO platform console shell: a navy sidebar on desktop, a
// drawer on small screens. The operator shown is the one the API just
// re-verified for this request (from the server layout).
export function PlatformShell({
  operator,
  children,
}: {
  operator: PlatformOperatorProfile;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!drawerOpen) {
      // Return focus to the control that opened the drawer.
      if (wasOpen.current) menuButton.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="flex min-h-dvh bg-surface-page">
      <a
        inert={drawerOpen}
        href="#platform-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>

      <aside className="cx-dark hidden w-64 shrink-0 border-r border-border-default bg-surface-sidebar lg:block">
        <div className="sticky top-0 h-dvh">
          <SidebarContent operator={operator} />
        </div>
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-label="Platform navigation"
            className="cx-dark relative h-full w-72 max-w-[85vw] bg-surface-sidebar shadow-xl"
          >
            <button
              ref={closeButton}
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-surface-subtle hover:text-text-primary"
            >
              <IconClose className="h-5 w-5" />
            </button>
            <SidebarContent
              operator={operator}
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <div inert={drawerOpen} className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border-default bg-surface-card px-4 lg:hidden">
          <button
            ref={menuButton}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls={drawerOpen ? drawerId : undefined}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-text-primary hover:bg-surface-subtle"
          >
            <IconMenuBars className="h-5 w-5" />
          </button>
          <CenterivoWordmark />
          <span className="ml-auto text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Platform
          </span>
        </header>
        <main
          id="platform-main"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus:outline-none sm:px-6 lg:px-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
