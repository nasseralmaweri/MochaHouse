import Link from "next/link";

// Section nav for Admin → Gift Cards (Milestone 7F). Server-rendered; each
// tab is only shown when the viewer holds the permission its page needs.
// The API re-checks on every request regardless.
export interface GiftCardTabsProps {
  active: "gift-cards" | "configuration";
  canViewOrManage: boolean;
  canConfigure: boolean;
}

export function GiftCardTabs({
  active,
  canViewOrManage,
  canConfigure,
}: GiftCardTabsProps) {
  const tabs: { key: GiftCardTabsProps["active"]; label: string; href: string }[] =
    [];
  if (canViewOrManage) {
    tabs.push({ key: "gift-cards", label: "Gift cards", href: "/admin/gift-cards" });
  }
  if (canConfigure) {
    tabs.push({
      key: "configuration",
      label: "Purchasing configuration",
      href: "/admin/gift-cards/configuration",
    });
  }

  if (tabs.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label="Gift Card sections"
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
