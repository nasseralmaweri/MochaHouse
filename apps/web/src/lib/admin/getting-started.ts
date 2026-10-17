import type {
  AdminGettingStartedResponse,
  GettingStartedStepKey,
} from "@mocha-house/contracts";

// SC4d — how the getting-started checklist reads. The API decides which
// steps are done (from the business's real data); this module only words
// them and points each open step at the page that does it.

export interface GettingStartedStepView {
  key: GettingStartedStepKey;
  title: string;
  description: string;
  done: boolean;
  // The page that does this step; null when there is nothing to do there.
  action: { label: string; href: string } | null;
}

const STEP_COPY: Record<
  GettingStartedStepKey,
  { title: string; todo: string; done: string }
> = {
  business: {
    title: "Create your business account",
    todo: "Create your business account.",
    done: "Your business account is ready.",
  },
  billing: {
    title: "Start your subscription or trial",
    todo: "Set up payment for your plan. Your plan's features unlock once the payment setup is confirmed.",
    done: "Your plan is set up.",
  },
  location: {
    title: "Add your first location",
    todo: "Add the restaurant or café your customers will order from.",
    done: "Your first location is added.",
  },
  profile: {
    title: "Add the address, time zone and phone",
    todo: "Customers see where you are and how to reach you. Opening hours use the location's time zone.",
    done: "Address, time zone and phone are set.",
  },
  hours: {
    title: "Set your opening hours",
    todo: "Add the days and times you're open. You can add more than one period a day, or one that runs past midnight.",
    done: "Opening hours are set.",
  },
  menu: {
    title: "Build your menu",
    todo: "Create your location's menu with at least one active product that has a price.",
    done: "Your menu has at least one product customers can buy.",
  },
  ordering: {
    title: "Turn on online ordering",
    todo: "Once the steps above are done, turn on online ordering for your location.",
    done: "Online ordering is turned on.",
  },
};

export function gettingStartedStepTitle(key: GettingStartedStepKey): string {
  return STEP_COPY[key].title;
}

function actionFor(
  key: GettingStartedStepKey,
  checklist: AdminGettingStartedResponse,
): GettingStartedStepView["action"] {
  const location = checklist.locationId
    ? `/admin/locations/${encodeURIComponent(checklist.locationId)}`
    : null;
  switch (key) {
    case "business":
      return null;
    case "billing":
      return { label: "Set up payment", href: "/admin/billing" };
    case "location":
      return { label: "Add location", href: "/admin/locations/new" };
    case "profile":
      return location
        ? { label: "Add details", href: `${location}/profile` }
        : null;
    case "hours":
      return location
        ? { label: "Set hours", href: `${location}/hours` }
        : null;
    case "menu":
      if (!location) return null;
      return checklist.menuId
        ? {
            label: "Add products",
            href: `/admin/menu/menus/${encodeURIComponent(checklist.menuId)}`,
          }
        : { label: "Create menu", href: `${location}/choose-menu` };
    case "ordering":
      return location
        ? {
            label: "Turn on online ordering",
            href: `${location}#online-ordering`,
          }
        : null;
  }
}

export function gettingStartedSteps(
  checklist: AdminGettingStartedResponse,
): GettingStartedStepView[] {
  return checklist.steps.map((step) => ({
    key: step.key,
    title: STEP_COPY[step.key].title,
    description: step.done ? STEP_COPY[step.key].done : STEP_COPY[step.key].todo,
    done: step.done,
    action: step.done ? null : actionFor(step.key, checklist),
  }));
}

// The first open step — what the owner should do next.
export function nextGettingStartedStep(
  checklist: AdminGettingStartedResponse,
): GettingStartedStepView | null {
  return gettingStartedSteps(checklist).find((step) => !step.done) ?? null;
}

export function gettingStartedProgressLabel(
  checklist: AdminGettingStartedResponse,
): string {
  return `${checklist.completedCount} of ${checklist.totalCount} steps done`;
}

// Shown with the finished checklist. "Setup complete" must never read as
// "live": online ordering may be on, but until this deployment's storefront
// serves the business (SC4f) customers cannot reach it, and the remaining
// launch steps are separate.
export const SETUP_COMPLETE_TITLE = "Setup complete";

export function setupCompleteNote(storefrontLive: boolean): string {
  return storefrontLive
    ? "Your online storefront serves this business, so customers can order from locations where online ordering is on."
    : "Your business isn't publicly live yet. Online ordering is turned on for your location, but customers can't reach your online storefront until it launches. That and the remaining launch steps are still to come.";
}

export function setupCompleteBadge(storefrontLive: boolean): string {
  return storefrontLive ? "Storefront live" : "Not live yet";
}

// For a location page: online ordering is on, but customers can't reach
// the business's storefront yet.
export const ORDERING_ON_NOT_LIVE =
  "Your online storefront isn't launched yet, so customers can't reach this location online.";

// The open steps a 409 from the online-ordering switch named, as a sentence.
export function orderingNotReadyMessage(
  missing: readonly GettingStartedStepKey[],
): string {
  if (missing.length === 0) {
    return "Finish setting up this location before turning on online ordering.";
  }
  const titles = missing.map((key) => STEP_COPY[key].title.toLowerCase());
  return `Before you can turn on online ordering, finish: ${titles.join("; ")}.`;
}
