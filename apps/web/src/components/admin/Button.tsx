"use client";

import Link from "next/link";

type Variant = "primary" | "secondary";

const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-text-muted";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:bg-accent/90",
  secondary:
    "border border-border-default bg-surface-card text-text-primary hover:bg-surface-subtle",
};

// Replaces the button class string that the Admin order screens copy-paste.
export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`${base} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function ButtonLink({
  variant = "secondary",
  className = "",
  href,
  children,
}: {
  variant?: Variant;
  className?: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

// A button that stays focusable while it is briefly unavailable
// (aria-disabled instead of disabled), so a keyboard or screen-reader user
// never loses their place when a list action is busy or a row moves to an
// end. Clicks are ignored while unavailable.
export function SoftDisabledButton({
  unavailable,
  onClick,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  unavailable: boolean;
}) {
  return (
    <Button
      {...props}
      aria-disabled={unavailable || undefined}
      className={`aria-disabled:cursor-not-allowed aria-disabled:bg-surface-subtle aria-disabled:text-text-muted ${className}`}
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}
