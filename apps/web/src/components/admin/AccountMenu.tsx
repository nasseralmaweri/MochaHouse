"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  InternalBusinessSummary,
  InternalUserProfile,
} from "@mocha-house/contracts";
import { internalSignOutAction } from "@/lib/internal-auth/actions";
import {
  IconChevronsUpDown,
  IconSignOut,
} from "@/components/centerivo/Icons";

function initialsOf(user: InternalUserProfile): string {
  const source = (user.displayName ?? user.email).trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

// The account disclosure at the foot of the sidebar: who is signed in, which
// business they are signed in to, and sign out. A proper menu button —
// aria-haspopup / aria-expanded / aria-controls, focus moves to the first
// item on open, Esc closes and returns focus, click-outside closes.
export function AccountMenu({
  user,
  business,
  collapsed = false,
}: {
  user: InternalUserProfile;
  business: InternalBusinessSummary;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const label = user.displayName ?? user.email;
  const initials = initialsOf(user);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={collapsed ? `Account: ${label}` : undefined}
        onClick={() => setOpen((value) => !value)}
        className={`group flex w-full items-center rounded-lg text-left transition-colors hover:bg-surface-subtle ${
          collapsed ? "h-11 justify-center" : "min-h-12 gap-3 px-2.5 py-2"
        }`}
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-text-primary ring-1 ring-border-default"
        >
          {initials}
        </span>
        {collapsed ? null : (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-text-primary">
                {label}
              </span>
              {user.displayName ? (
                <span className="truncate text-xs text-text-muted">
                  {user.email}
                </span>
              ) : null}
            </span>
            <IconChevronsUpDown className="h-4 w-4 text-text-muted group-hover:text-text-secondary" />
          </>
        )}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label="Account"
          className={`cx-light cx-pop-in absolute z-40 w-64 rounded-xl border border-border-default bg-surface-card p-1.5 ${
            collapsed ? "bottom-0 left-full ml-2" : "bottom-full left-0 mb-2"
          }`}
          style={{ boxShadow: "var(--cx-shadow-pop)" }}
        >
          <div className="flex flex-col gap-0.5 px-2.5 pb-2.5 pt-2 text-sm">
            <span className="truncate font-medium text-text-primary">
              {label}
            </span>
            {user.displayName ? (
              <span className="truncate text-xs text-text-muted">
                {user.email}
              </span>
            ) : null}
            <span className="pt-1.5 text-xs text-text-muted">
              Signed in to{" "}
              <span className="font-medium text-text-secondary">
                {business.name}
              </span>
            </span>
          </div>
          <div className="border-t border-border-default pt-1.5">
            <form action={internalSignOutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-text-primary transition-colors hover:bg-surface-subtle focus-visible:bg-surface-subtle focus-visible:outline-none"
              >
                <IconSignOut className="h-4 w-4 text-text-muted" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
