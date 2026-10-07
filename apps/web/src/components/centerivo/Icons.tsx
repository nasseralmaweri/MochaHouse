// A small, self-contained icon set (24px grid, 1.6 stroke, round caps) in the
// style of common line-icon libraries. Decorative by default: icons never
// carry meaning alone — the label next to them (or an aria-label on the
// control) does.
type IconProps = { className?: string };

function Svg({
  className = "h-[18px] w-[18px]",
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11.5 12 5l8 6.5" />
    <path d="M6 10v9h4v-5h4v5h4v-9" />
  </Svg>
);
export const IconOrders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4h12v16l-3-2-3 2-3-2-3 2z" />
    <path d="M9 9h6M9 13h4" />
  </Svg>
);
export const IconOperations = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5" width="16" height="15" rx="2" />
    <path d="M4 10h16M9 3v4M15 3v4" />
    <path d="m9 15 2 2 4-4" />
  </Svg>
);
export const IconApprovals = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 6v6c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);
export const IconLocations = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.3" />
  </Svg>
);
export const IconCustomers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3.5 19c.5-3 2.7-4.6 5.5-4.6s5 1.6 5.5 4.6" />
    <path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.8.5 3 1.9 3.3 4.4" />
  </Svg>
);
export const IconLoyalty = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z" />
  </Svg>
);
export const IconPromotions = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 13.5 13.5 20a2 2 0 0 1-2.8 0L4 13.3V4h9.3L20 10.7a2 2 0 0 1 0 2.8z" />
    <circle cx="8.5" cy="8.5" r="1.2" />
  </Svg>
);
export const IconGiftCards = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="9" width="17" height="11" rx="1.5" />
    <path d="M3.5 13h17M12 9v11" />
    <path d="M12 9c-1-3-5.5-3.5-5.5-1S10 9 12 9zm0 0c1-3 5.5-3.5 5.5-1S14 9 12 9z" />
  </Svg>
);
export const IconMarketing = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 13V9.5l12-5v15l-12-5z" />
    <path d="M7.5 15 9 20h3" />
    <path d="M19.5 9.5v4" />
  </Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3v7a2 2 0 0 0 2 2v9M10 3v7a2 2 0 0 1-2 2M8 3v4" />
    <path d="M17 21V3c-2.5 1.5-3.5 4-3.5 7 0 1.5 1 2 2 2h1.5" />
  </Svg>
);
export const IconContent = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3.5h7l4 4V20.5H7z" />
    <path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6" />
  </Svg>
);
export const IconMedia = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 3.5 3 3-2.5L20 16" />
  </Svg>
);
export const IconCareers = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="8" width="17" height="11.5" rx="2" />
    <path d="M9 8V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2M3.5 13h17" />
  </Svg>
);
export const IconFranchising = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V9l8-5 8 5v11" />
    <path d="M9 20v-6h6v6M4 20h16" />
  </Svg>
);
export const IconReports = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4v16h16" />
    <path d="M8 16v-4M12.5 16V8M17 16v-6" />
  </Svg>
);
export const IconAdministration = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
  </Svg>
);
export const IconBusiness = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 20.5V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5v15" />
    <path d="M15 10h2.5A1.5 1.5 0 0 1 19 11.5v9M3.5 20.5h17" />
    <path d="M8.5 8h3M8.5 11.5h3M8.5 15h3" />
  </Svg>
);
export const IconAllLocations = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.4-5.2-3.4-8.5S9.6 5.9 12 3.5z" />
  </Svg>
);
export const IconChevronsUpDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 9.5 4-4 4 4M8 14.5l4 4 4-4" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Svg>
);
export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M9.5 4.5v15" />
  </Svg>
);
export const IconMenuBars = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);
export const IconSignOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10" />
    <path d="M15 8.5 19 12l-4 3.5M19 12H9.5" />
  </Svg>
);
export const IconSpinner = ({ className = "h-4 w-4" }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    className={`cx-spin shrink-0 ${className}`}
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

import type { ComponentType } from "react";

// Navigation item key -> icon. Keys come from lib/admin/nav.ts.
export const NAV_ICONS: Record<string, ComponentType<IconProps>> = {
  dashboard: IconHome,
  orders: IconOrders,
  operations: IconOperations,
  approvals: IconApprovals,
  locations: IconLocations,
  customers: IconCustomers,
  loyalty: IconLoyalty,
  promotions: IconPromotions,
  "gift-cards": IconGiftCards,
  marketing: IconMarketing,
  menu: IconMenu,
  content: IconContent,
  media: IconMedia,
  careers: IconCareers,
  franchising: IconFranchising,
  reports: IconReports,
  administration: IconAdministration,
};

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4 3.5 19h17z" />
    <path d="M12 10v4M12 16.8v.2" />
  </Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8v.2" />
  </Svg>
);
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.3 2.5 2.5 4.5-5" />
  </Svg>
);
