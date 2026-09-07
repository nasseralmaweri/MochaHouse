import Link from "next/link";

// The section nav for Admin → Loyalty (Milestone 7B). Server-rendered; each
// tab is only shown when the viewer holds the permission its page needs.
// The API re-checks on every request regardless.
export interface LoyaltyTabsProps {
  active: "customers" | "rewards" | "settings";
  canView: boolean;
  canConfigure: boolean;
}

export function LoyaltyTabs({ active, canView, canConfigure }: LoyaltyTabsProps) {
  const tabs: { key: LoyaltyTabsProps["active"]; label: string; href: string }[] =
    [];
  if (canView) {
    tabs.push({
      key: "customers",
      label: "Customer lookup",
      href: "/admin/loyalty",
    });
  }
  if (canConfigure) {
    tabs.push({
      key: "rewards",
      label: "Rewards",
      href: "/admin/loyalty/rewards",
    });
    tabs.push({
      key: "settings",
      label: "Settings",
      href: "/admin/loyalty/settings",
    });
  }

  if (tabs.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label="Loyalty sections"
      className="flex flex-wrap gap-1 border-b border-border-default"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
            tab.key === active
              ? "border-text-primary text-text-primary"
              : "border-transparent text-text-secondary hover:text-text-primary"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
