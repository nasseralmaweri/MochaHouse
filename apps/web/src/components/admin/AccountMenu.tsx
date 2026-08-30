"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { InternalUserProfile } from "@mocha-house/contracts";
import { internalSignOutAction } from "@/lib/internal-auth/actions";

// The account disclosure in the top bar: shows who is signed in and offers
// sign out. A proper disclosure widget — aria-expanded / aria-controls, Esc
// to close, click-outside to close, focus returns to the trigger.
export function AccountMenu({ user }: { user: InternalUserProfile }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

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

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-2 rounded-xl border border-border-default bg-surface-card px-3 py-1.5 text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="max-w-[10rem] truncate">{label}</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="menu"
          className="absolute right-0 z-30 mt-2 flex w-64 flex-col gap-2 rounded-xl border border-border-default bg-surface-card p-3 shadow-lg"
        >
          <div className="flex flex-col gap-0.5 border-b border-border-default pb-2 text-sm">
            {user.displayName ? (
              <span className="font-medium text-text-primary">
                {user.displayName}
              </span>
            ) : null}
            <span className="text-text-secondary">{user.email}</span>
          </div>
          <form action={internalSignOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-xl px-2 py-2 text-left text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
