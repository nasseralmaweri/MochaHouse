// SC1b — the CENTERIVO platform console's navigation. Only modules that are
// actually built are links; the rest are listed as "Coming soon" and are not
// navigable (no placeholder screens, no invented data).

export type PlatformNavKey =
  | "overview"
  | "tenants"
  | "plans"
  | "subscriptions"
  | "billing"
  | "support"
  | "settings";

export interface PlatformNavItem {
  key: PlatformNavKey;
  label: string;
  href: string | null; // null = not available yet
  description: string;
}

export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  {
    key: "overview",
    label: "Overview",
    href: "/platform",
    description: "Platform status at a glance.",
  },
  {
    key: "tenants",
    label: "Tenants",
    href: null,
    description: "Businesses on CENTERIVO and their lifecycle.",
  },
  {
    key: "plans",
    label: "Plans",
    href: null,
    description: "Plans, modules and entitlements.",
  },
  {
    key: "subscriptions",
    label: "Subscriptions",
    href: null,
    description: "Each business's subscription and trial.",
  },
  {
    key: "billing",
    label: "Billing",
    href: null,
    description: "Invoices and SaaS revenue.",
  },
  {
    key: "support",
    label: "Support",
    href: null,
    description: "Audited support access and diagnostics.",
  },
  {
    key: "settings",
    label: "Settings",
    href: null,
    description: "Platform configuration and operators.",
  },
];

export function isAvailable(item: PlatformNavItem): boolean {
  return item.href !== null;
}
