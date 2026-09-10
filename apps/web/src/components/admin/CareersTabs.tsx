import Link from "next/link";

// Section nav for Admin → Careers (Milestone 8B Jobs + Milestone 8C
// Applicants). Server-rendered; each tab is shown only when the viewer holds
// the permission its page needs (`careers.view` for Jobs, `applicants.view`
// for Applicants). The API re-checks on every request regardless.
export interface CareersTabsProps {
  active: "jobs" | "applicants";
  canViewJobs: boolean;
  canViewApplicants: boolean;
}

export function CareersTabs({
  active,
  canViewJobs,
  canViewApplicants,
}: CareersTabsProps) {
  const tabs: { key: CareersTabsProps["active"]; label: string; href: string }[] =
    [];
  if (canViewJobs) {
    tabs.push({ key: "jobs", label: "Jobs", href: "/admin/careers" });
  }
  if (canViewApplicants) {
    tabs.push({
      key: "applicants",
      label: "Applicants",
      href: "/admin/careers/applicants",
    });
  }

  if (tabs.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label="Careers sections"
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
