"use client";

import { useEffect, useRef } from "react";
import type { AdminNavItem } from "@/lib/admin/nav";
import { AdminNav } from "./AdminNav";

// The off-canvas navigation drawer for narrow viewports. Opened from the
// top-bar toggle. Keyboard-operable: Esc closes, focus moves into the
// drawer on open and returns to the toggle on close, focus is trapped while
// open, background is inert-ish (pointer + tab). Backdrop click closes.
export function MobileNav({
  open,
  onClose,
  items,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  items: AdminNavItem[];
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const trigger = triggerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled])',
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = original;
      (trigger ?? previouslyFocused)?.focus();
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div
        className="absolute inset-0 bg-text-primary/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Admin navigation"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col gap-4 border-r border-border-default bg-surface-card p-4 focus:outline-none"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text-primary">
            Mocha House Admin
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            aria-label="Close navigation"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <AdminNav items={items} onNavigate={onClose} />
      </div>
    </div>
  );
}
