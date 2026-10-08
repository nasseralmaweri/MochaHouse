import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type {
  AdminCustomerGrowthReport,
  AdminLocationPerformanceReport,
  AdminOperationsChecklistReport,
  AdminOrdersOverviewReport,
  LocationSummary,
  OperationsTasksResponse,
  StoreOrderSummary,
} from "@mocha-house/contracts";
import { isActiveOrderStatus } from "@mocha-house/domain";
import {
  getInternalSession,
  ADMIN_LOCATION_COOKIE,
} from "@/lib/internal-auth/session";
import { getActiveStoreOrders } from "@/lib/internal-auth/admin-orders";
import {
  getAdminCustomerGrowthReport,
  getAdminLocationPerformanceReport,
  getAdminOperationsChecklistReport,
  getAdminOrdersOverviewReport,
} from "@/lib/internal-auth/admin-reports";
import { getAdminApprovals } from "@/lib/internal-auth/admin-approvals";
import { getAdminJobApplications } from "@/lib/internal-auth/admin-applicants";
import { getAdminFranchiseInquiries } from "@/lib/internal-auth/admin-franchising";
import { getOperationsTasksSnapshot } from "@/lib/internal-auth/admin-operations";
import {
  can,
  canAtLocation,
  type AdminCapabilities,
} from "@/lib/admin/capabilities";
import {
  digitalOrderingAttentionItems,
  type AttentionItem,
} from "@/lib/admin/attention";
import {
  locationContextValue,
  resolveLocationContext,
} from "@/lib/admin/location-context";
import {
  applicantsAttention,
  approvalsAttention,
  buildLocationRows,
  businessToday,
  checklistExceptionAttention,
  checklistState,
  describeRange,
  formatBusinessDate,
  inquiriesAttention,
  openTasksAttention,
  parseOverviewRange,
  prioritizeAttention,
  rangeDates,
  resolveOverviewScope,
  shortLocationName,
  waitingOrdersAttention,
  type OverviewRange,
} from "@/lib/admin/overview";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminEmptyState, AdminForbidden } from "@/components/admin/states";
import { OverviewScopeSwitcher } from "@/components/admin/OverviewScopeSwitcher";
import {
  ContinueWorking,
  LiveQueue,
  OperatingState,
  PerformanceSummary,
  RangeTabs,
  SectionHeading,
  type ContinueLink,
  type OperatingFact,
} from "@/components/admin/OverviewSections";
import {
  AllClearPanel,
  CustomerActivity,
  DigitalPerformance,
  LocationBoard,
  LocationsSummary,
  OverviewHero,
  PanelSection,
  SectionUnavailable,
} from "@/components/admin/CompanyOverview";
import { AttentionList } from "@/components/centerivo/Attention";
import { DataCoverage } from "@/components/centerivo/DataCoverage";

// Every read is independent and independently authorized by the API. A read
// that is FORBIDDEN simply isn't shown (the person's role doesn't include
// it); one that ERRORS is reported honestly and never counted as "all clear".
type Loaded<T> =
  | { state: "ok"; data: T }
  | { state: "absent" }
  | { state: "error" };

type ReadLike<T> =
  | { outcome: "success"; data: T }
  | { outcome: string };

function loaded<T>(result: ReadLike<T> | null): Loaded<T> {
  if (result === null) return { state: "absent" };
  if (result.outcome === "success") {
    return { state: "ok", data: (result as { data: T }).data };
  }
  if (result.outcome === "forbidden") return { state: "absent" };
  return { state: "error" };
}

function ordersLoaded(
  result: Awaited<ReturnType<typeof getActiveStoreOrders>> | null,
): Loaded<StoreOrderSummary[]> {
  if (result === null) return { state: "absent" };
  if (result.outcome === "success") {
    return {
      state: "ok",
      data: result.orders.filter((o) => isActiveOrderStatus(o.status)),
    };
  }
  return result.outcome === "forbidden" ? { state: "absent" } : { state: "error" };
}

function tasksLoaded(
  result: Awaited<ReturnType<typeof getOperationsTasksSnapshot>> | null,
): Loaded<OperationsTasksResponse> {
  if (result === null) return { state: "absent" };
  if (result.outcome === "success") return { state: "ok", data: result.tasks };
  return result.outcome === "forbidden" ? { state: "absent" } : { state: "error" };
}

function AttentionCount({ count }: { count: number }) {
  return (
    <p className="text-sm text-text-secondary">
      {count === 0
        ? "Nothing waiting"
        : `${count} ${count === 1 ? "item" : "items"} to look at`}
    </p>
  );
}

function overviewHref(location: string | null, range: OverviewRange): string {
  const params = new URLSearchParams();
  if (location) params.set("location", location);
  if (range !== "today") params.set("range", range);
  const qs = params.toString();
  return qs ? `/admin?${qs}` : "/admin";
}

// CENTERIVO Overview. Business -> Scope -> Work: the active business is the
// session's; the scope is Company-wide or one authorized location, and the
// page deliberately changes shape by scope.
export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; range?: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { permissions, isCorporate, locations, capabilities } =
    session.authorization;
  const { location: urlLocationId, range: rawRange } = await searchParams;
  const cookieStore = await cookies();
  const cookieLocationId = cookieStore.get(ADMIN_LOCATION_COOKIE)?.value ?? null;

  const locationContext = resolveLocationContext({
    authorizedLocations: locations,
    isCorporate,
    urlLocationId: urlLocationId ?? null,
    cookieLocationId,
  });
  const scope = resolveOverviewScope(locationContext);
  const range = parseOverviewRange(rawRange);
  const today = businessToday(new Date());
  const businessName = session.business.name;

  // --- Nothing operational is granted yet ------------------------------
  if (permissions.length === 0) {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Overview"
          description={`${businessName} · Your CENTERIVO workspace`}
        />
        <AdminEmptyState
          title="You don't have operational access yet"
          description="Your internal account is active, but no role has been assigned to it. An administrator needs to grant you a role before you can work here."
        />
      </AdminPage>
    );
  }

  if (scope.kind === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Overview" description={businessName} />
        <AdminForbidden
          title="You're not assigned to that location"
          description="The location in this link isn't in your assigned scope. Pick one of your locations from the scope selector."
        />
      </AdminPage>
    );
  }

  const scopeLabel =
    scope.kind === "company"
      ? "Company-wide"
      : scope.kind === "location"
        ? shortLocationName(scope.location.name, businessName)
        : "No location";

  const header = (
    <AdminPageHeader
      title="Overview"
      description={
        scope.kind === "location"
          ? `${scopeLabel} · ${formatBusinessDate(today)}`
          : scope.kind === "company"
            ? formatBusinessDate(today)
            : `${businessName} · ${scopeLabel} · ${formatBusinessDate(today)}`
      }
      actions={
        scope.kind === "none" ? undefined : (
          <OverviewScopeSwitcher
            locations={locations}
            isCorporate={isCorporate}
            currentValue={locationContextValue(locationContext)}
            businessName={businessName}
          />
        )
      }
    />
  );

  if (scope.kind === "none") {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No locations assigned yet"
          description="Your role is active, but it isn't tied to a location. An administrator can assign one."
        />
      </AdminPage>
    );
  }

  const rangeLabel = describeRange(range, today);
  const { startDate, endDate } = rangeDates(range, today);

  const body =
    scope.kind === "company"
      ? await companyOverview({
          capabilities,
          locations,
          businessName,
          range,
          rangeLabel,
          startDate,
          endDate,
          today,
          urlLocationId: urlLocationId ?? null,
        })
      : await locationOverview({
          capabilities,
          location: scope.location,
          shortName: shortLocationName(scope.location.name, businessName),
          range,
          rangeLabel,
          startDate,
          endDate,
          today,
        });

  return (
    <AdminPage width="wide">
      {header}
      {body}
    </AdminPage>
  );
}

type Capabilities = AdminCapabilities;

// ---------------------------------------------------------------------------
// COMPANY-WIDE
// ---------------------------------------------------------------------------
async function companyOverview({
  capabilities,
  locations,
  businessName,
  range,
  rangeLabel,
  startDate,
  endDate,
  today,
  urlLocationId,
}: {
  capabilities: Capabilities;
  locations: LocationSummary[];
  businessName: string;
  range: OverviewRange;
  rangeLabel: string;
  startDate: string;
  endDate: string;
  today: string;
  urlLocationId: string | null;
}) {
  const canReports = can(capabilities, "reports.view");

  const [overview, performance, checklist, growth, approvals, applicants, inquiries] =
    await Promise.all([
      canReports
        ? getAdminOrdersOverviewReport({ startDate, endDate, locationId: null })
        : null,
      canReports ? getAdminLocationPerformanceReport({ startDate, endDate }) : null,
      canReports
        ? getAdminOperationsChecklistReport({ startDate: today, endDate: today })
        : null,
      canReports ? getAdminCustomerGrowthReport({ startDate, endDate }) : null,
      can(capabilities, "approvals.view")
        ? getAdminApprovals({ status: "PENDING" })
        : null,
      can(capabilities, "applicants.view")
        ? getAdminJobApplications({ status: "NEW" })
        : null,
      can(capabilities, "franchising.view")
        ? getAdminFranchiseInquiries({ status: "NEW" })
        : null,
    ]);

  const overviewR: Loaded<AdminOrdersOverviewReport> = loaded(overview);
  const performanceR: Loaded<AdminLocationPerformanceReport> = loaded(performance);
  const checklistR: Loaded<AdminOperationsChecklistReport> = loaded(checklist);
  const growthR: Loaded<AdminCustomerGrowthReport> = loaded(growth);
  const approvalsR = loaded(approvals);
  const applicantsR = loaded(applicants);
  const inquiriesR = loaded(inquiries);

  // --- Needs attention --------------------------------------------------
  // Existing 5C logic, unchanged: a disabled location is surfaced only where
  // locations.manage_digital_ordering is effective FOR THAT location.
  const items: AttentionItem[] = digitalOrderingAttentionItems(
    locations,
    capabilities,
  ).map((item) => {
    const location = locations.find(
      (l) => item.id === `digital-ordering-${l.id}`,
    );
    return {
      ...item,
      description: "Customers can't place online orders here.",
      context: location?.name,
      actionLabel: "Review",
    };
  });
  if (checklistR.state === "ok") {
    items.push(...checklistExceptionAttention(checklistR.data.locations, null));
  }
  const checked: string[] = ["online ordering"];
  const unavailable: string[] = [];
  if (checklistR.state === "ok") checked.push("checklist exceptions");
  if (checklistR.state === "error") unavailable.push("checklist exceptions");
  if (approvalsR.state === "error") unavailable.push("approvals");
  if (approvalsR.state === "ok") {
    checked.push("approvals");
    const item = approvalsAttention(
      approvalsR.data.approvalRequests.length,
      approvalsR.data.nextCursor !== null,
    );
    if (item) items.push(item);
  }
  if (applicantsR.state === "error") unavailable.push("new applicants");
  if (applicantsR.state === "ok") {
    checked.push("new applicants");
    const item = applicantsAttention(
      applicantsR.data.applications.length,
      applicantsR.data.nextCursor !== null,
    );
    if (item) items.push(item);
  }
  if (inquiriesR.state === "error") unavailable.push("franchise inquiries");
  if (inquiriesR.state === "ok") {
    checked.push("franchise inquiries");
    const item = inquiriesAttention(
      inquiriesR.data.inquiries.length,
      inquiriesR.data.nextCursor !== null,
    );
    if (item) items.push(item);
  }
  const attention = prioritizeAttention(items);

  // --- Location comparison ----------------------------------------------
  const rows =
    performanceR.state === "ok"
      ? buildLocationRows(
          performanceR.data.locations,
          checklistR.state === "ok" ? checklistR.data.locations : null,
        )
      : [];

  const continueLinks: ContinueLink[] = [
    can(capabilities, "orders.view") && {
      label: "Orders",
      description: "The live queue, by location",
      href: "/admin/orders",
    },
    (can(capabilities, "operations.view") ||
      can(capabilities, "operations.checklists.configure")) && {
      label: "Operations",
      description: "Checklists and today's tasks",
      href: "/admin/operations",
    },
    can(capabilities, "customers.view") && {
      label: "Customers",
      description: "Accounts, rewards and notes",
      href: "/admin/customers",
    },
    can(capabilities, "catalog.view") && {
      label: "Menu & Products",
      description: "Products, menus and prices",
      href: "/admin/menu",
    },
    canReports && {
      label: "Reports",
      description: "Digital reports and exports",
      href: "/admin/reports",
    },
  ].filter((link): link is ContinueLink => Boolean(link));

  const periodLabel =
    range === "today" ? `Today · ${formatBusinessDate(today)}` : rangeLabel;
  const shortPeriod = range === "today" ? "Today" : rangeLabel.split(" · ")[0];

  const warningCount = attention.filter((i) => i.severity === "warning").length;
  const flaggedLocations = rows.filter((r) => r.flags.length > 0).length;

  // 1. Needs attention — a list when there is work, a checklist of what was
  // looked at when there isn't, and an honest notice when checks failed.
  const attentionSection = (
    <PanelSection
      id="ov-attention"
      title="Needs attention"
      aside={attention.length > 0 ? "Most urgent first" : undefined}
      step={1}
      className={canReports ? "lg:col-span-5" : ""}
    >
      {attention.length === 0 && unavailable.length === 0 ? (
        <AllClearPanel checked={checked} />
      ) : (
        <AttentionList
          items={attention}
          checkedLabel={checked.join(", ")}
          unavailable={unavailable}
          grouped
        />
      )}
    </PanelSection>
  );

  return (
    <div className="flex min-w-0 flex-col gap-8 md:gap-10">
      <OverviewHero
        businessName={businessName}
        locationCount={locations.length}
        attentionCount={attention.length}
        warningCount={warningCount}
        unavailable={unavailable}
        range={range}
        periodLabel={periodLabel}
        hrefFor={(r) => overviewHref(urlLocationId, r)}
        showPeriod={canReports}
        links={continueLinks}
      />

      {canReports ? (
        <>
          <div className="grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-6">
            {attentionSection}

            {/* 2. Digital performance */}
            <PanelSection
              id="ov-performance"
              title="Digital performance"
              aside={shortPeriod}
              step={2}
              className="lg:col-span-7"
            >
              {overviewR.state === "ok" ? (
                <DigitalPerformance report={overviewR.data} range={range} />
              ) : (
                <SectionUnavailable title="Digital performance couldn't be loaded" />
              )}
            </PanelSection>
          </div>

          {/* 3. Customer activity */}
          <PanelSection
            id="ov-customers"
            title="Customer activity"
            aside={shortPeriod}
            step={3}
          >
            {growthR.state === "ok" ? (
              <CustomerActivity
                growth={growthR.data}
                range={range}
                customersHref={
                  can(capabilities, "customers.view") ? "/admin/customers" : null
                }
                loyaltyHref={
                  can(capabilities, "loyalty.view") ? "/admin/loyalty" : null
                }
              />
            ) : (
              <SectionUnavailable title="Customer activity couldn't be loaded" />
            )}
          </PanelSection>

          {/* 4. Locations */}
          <PanelSection
            id="ov-locations"
            title="Locations"
            step={4}
            aside={
              performanceR.state === "ok" ? (
                <LocationsSummary total={rows.length} needingLook={flaggedLocations} />
              ) : undefined
            }
          >
            {performanceR.state === "ok" ? (
              <LocationBoard
                rows={rows}
                periodName={shortPeriod}
                showChecklists={checklistR.state === "ok"}
                checklistsUnavailable={checklistR.state === "error"}
                hrefFor={(id) => overviewHref(id, range)}
              />
            ) : (
              <SectionUnavailable title="The location summary couldn't be loaded" />
            )}
          </PanelSection>
        </>
      ) : (
        <>
          {attentionSection}
          <SectionUnavailable
            title="Performance, customer and location figures aren't part of your role"
            description="Digital performance, customer activity and the location summary appear here for people whose role includes Reports. Ask an administrator if you need them."
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ONE LOCATION
// ---------------------------------------------------------------------------
async function locationOverview({
  capabilities,
  location,
  shortName,
  range,
  rangeLabel,
  startDate,
  endDate,
  today,
}: {
  capabilities: Capabilities;
  location: LocationSummary;
  shortName: string;
  range: OverviewRange;
  rangeLabel: string;
  startDate: string;
  endDate: string;
  today: string;
}) {
  const canOrders = canAtLocation(capabilities, "orders.view", location.id);
  const canOps = canAtLocation(capabilities, "operations.view", location.id);
  const canReports = can(capabilities, "reports.view");
  const encoded = encodeURIComponent(location.id);

  const [orders, tasks, overview, checklist] = await Promise.all([
    canOrders ? getActiveStoreOrders(location.id) : null,
    canOps ? getOperationsTasksSnapshot(location.id) : null,
    canReports
      ? getAdminOrdersOverviewReport({
          startDate,
          endDate,
          locationId: location.id,
        })
      : null,
    canReports
      ? getAdminOperationsChecklistReport({ startDate: today, endDate: today })
      : null,
  ]);

  const ordersR = ordersLoaded(orders);
  const tasksR = tasksLoaded(tasks);
  const overviewR: Loaded<AdminOrdersOverviewReport> = loaded(overview);
  const checklistR: Loaded<AdminOperationsChecklistReport> = loaded(checklist);

  // --- Needs attention (this location only) -----------------------------
  const items: AttentionItem[] = digitalOrderingAttentionItems(
    [location],
    capabilities,
  ).map((item) => ({
    ...item,
    description: "Customers can't place online orders here.",
    actionLabel: "Review",
  }));
  const checked: string[] = ["online ordering"];
  const unavailable: string[] = [];
  if (ordersR.state === "ok") {
    checked.push("new orders");
    const waiting = waitingOrdersAttention(location, ordersR.data);
    if (waiting) items.push(waiting);
  }
  if (ordersR.state === "error") unavailable.push("the order queue");
  if (tasksR.state === "ok") {
    checked.push("open tasks");
    const open = openTasksAttention(location, tasksR.data);
    if (open) items.push(open);
  }
  if (tasksR.state === "error") unavailable.push("today's tasks");
  if (checklistR.state === "ok") {
    checked.push("checklist exceptions");
    items.push(
      ...checklistExceptionAttention(checklistR.data.locations, location.id),
    );
  }
  if (checklistR.state === "error") unavailable.push("checklist exceptions");
  // Every item here belongs to the scoped location, which the header and
  // scope control already name — don't repeat it on each row.
  const attention = prioritizeAttention(items).map((item) => ({
    ...item,
    context: undefined,
  }));

  // --- Operating state ----------------------------------------------------
  const facts: OperatingFact[] = [
    {
      label: "Online ordering",
      value: location.isDigitalOrderingEnabled ? "On" : "Off",
      href: can(capabilities, "locations.view")
        ? `/admin/locations/${encoded}`
        : undefined,
    },
  ];
  if (tasksR.state === "ok") {
    facts.push({
      label: "Open tasks today",
      value: String(tasksR.data.openCount),
      href: `/admin/operations?location=${encoded}`,
    });
  }
  if (checklistR.state === "ok") {
    const row = checklistR.data.locations.find(
      (r) => r.locationId === location.id,
    );
    const label = (state: ReturnType<typeof checklistState>) =>
      state === "completed"
        ? "Done"
        : state === "in-progress"
          ? "In progress"
          : "Not recorded";
    facts.push(
      {
        label: "Opening checklist",
        value: label(
          row ? checklistState(row.openingStarted, row.openingCompleted) : "not-recorded",
        ),
        href: `/admin/operations/opening-checklist?location=${encoded}`,
      },
      {
        label: "Closing checklist",
        value: label(
          row ? checklistState(row.closingStarted, row.closingCompleted) : "not-recorded",
        ),
        href: `/admin/operations/closing-checklist?location=${encoded}`,
      },
    );
  }

  const continueLinks: ContinueLink[] = [
    canOrders && {
      label: "Orders",
      description: "This location's queue",
      href: `/admin/orders?location=${encoded}`,
    },
    canOps && {
      label: "Operations",
      description: "Checklists and today's tasks",
      href: `/admin/operations?location=${encoded}`,
    },
    canAtLocation(capabilities, "catalog.overrides.manage", location.id) && {
      label: "Menu here",
      description: "Prices and availability at this location",
      href: `/admin/locations/${encoded}/menu`,
    },
    can(capabilities, "customers.view") && {
      label: "Customers",
      description: "Accounts, rewards and notes",
      href: "/admin/customers",
    },
    canReports && {
      label: "Reports",
      description: "Digital reports and exports",
      href: "/admin/reports",
    },
  ].filter((link): link is ContinueLink => Boolean(link));

  return (
    <>
      <ContinueWorking links={continueLinks} />
      <div className="flex min-w-0 flex-col gap-10">
        <section aria-labelledby="ov-attention" className="flex flex-col gap-4">
          <SectionHeading
            id="ov-attention"
            title="Needs attention"
            description={`At ${shortName}.`}
            primary
            aside={<AttentionCount count={attention.length} />}
          />
          <AttentionList
            items={attention}
            checkedLabel={checked.join(", ")}
            unavailable={unavailable}
          />
        </section>

        {canOrders && ordersR.state !== "absent" ? (
          <section aria-labelledby="ov-queue" className="flex flex-col gap-4">
            <SectionHeading
              id="ov-queue"
              title="Live orders"
              description="Active digital orders right now."
            />
            {ordersR.state === "ok" ? (
              <LiveQueue
                orders={ordersR.data}
                href={`/admin/orders?location=${encoded}`}
              />
            ) : (
              <AdminEmptyState
                title="Couldn't load the order queue"
                description="Refresh to try again."
              />
            )}
          </section>
        ) : null}

        {canReports && overviewR.state !== "absent" ? (
          <section
            aria-labelledby="ov-performance"
            className="flex flex-col gap-4"
          >
            <SectionHeading
              id="ov-performance"
              title="Digital performance"
              description={`${shortName} · ${rangeLabel}`}
              aside={
                <RangeTabs
                  current={range}
                  hrefFor={(r) => overviewHref(location.id, r)}
                />
              }
            />
            {overviewR.state === "ok" ? (
              <PerformanceSummary
                report={overviewR.data}
                growth={null}
                headingId="ov-performance"
                coverageExtra={[`${shortName} only`]}
              />
            ) : (
              <AdminEmptyState
                title="Couldn't load digital performance"
                description="Refresh to try again."
              />
            )}
          </section>
        ) : null}

        <section aria-labelledby="ov-state" className="flex flex-col gap-4">
          <SectionHeading
            id="ov-state"
            title="Operating state"
            description="How this location is set up to run today."
          />
          <OperatingState facts={facts} />
          {checklistR.state === "ok" ? (
            <DataCoverage
              items={[
                "Checklists show today's recorded activity — “Not recorded” means nobody has opened it yet, not that it was missed",
              ]}
            />
          ) : null}
        </section>
      </div>

    </>
  );
}
