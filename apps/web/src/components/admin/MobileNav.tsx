"use client";

import { useEffect, useRef } from "react";
import { IconClose } from "@/components/centerivo/Icons";

// The off-canvas drawer for narrow viewports. It holds the SAME sidebar
// content as the desktop sidebar (business, location, modules, account) so
// nothing is reachable only on large screens. Keyboard-operable: Esc closes,
// focus moves into the drawer on open and returns to the trigger on close,
// focus is trapped while open, the page behind does not scroll, backdrop
// click closes.
export function MobileNav({
  open,
  onClose,
  triggerRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const trigger = triggerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      // The context popovers handle their own Escape (they stop at the
      // listbox); only close the drawer when no popover is open.
      if (event.key === "Escape") {
        if (panelRef.current?.querySelector('[aria-expanded="true"]')) return;
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled])',
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
        aria-label="Navigation"
        tabIndex={-1}
        className="cx-pop-in absolute inset-y-0 left-0 w-80 max-w-[88%] border-r border-border-default bg-surface-sidebar focus:outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3.5 z-10 flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-text-secondary transition-colors hover:bg-surface-subtle"
        >
          <IconClose className="h-4 w-4" />
          Close
        </button>
        {children}
      </div>
    </div>
  );
}
