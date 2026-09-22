import type {
  AdminCustomerGrowthReport,
  AdminLocationPerformanceReport,
  AdminOperationsChecklistReport,
  AdminOrdersOverviewReport,
  AdminReportDataSource,
  OrderStatus,
} from '@mocha-house/contracts';
import { escapeCsvCell, numericCsvCell } from './csv-serializer';

// Milestone 9E — pure, side-effect-free mappers from an already-computed,
// already-typed report result to CSV rows (string[][]). No database
// access, no services: each function's only input is the exact same
// object the report's own JSON endpoint already returns, so there is
// never a second implementation of any metric to drift out of sync.

const BLANK_ROW: string[] = [];

// Every export shares the same leading metadata shape: Report / Start
// Date / End Date / (report-specific extra rows, e.g. Location) / Source
// Scope / Source Description / Data Freshness / (report-specific Note
// rows, verbatim UI wording). Source values are read directly off
// `source` — never reworded here.
function metadataRows(
  reportTitle: string,
  filters: { startDate: string; endDate: string },
  extraRows: [string, string][],
  source: AdminReportDataSource,
  notes: string[],
): string[][] {
  const rows: string[][] = [
    [escapeCsvCell('Report'), escapeCsvCell(reportTitle)],
    [escapeCsvCell('Start Date'), escapeCsvCell(filters.startDate)],
    [escapeCsvCell('End Date'), escapeCsvCell(filters.endDate)],
  ];
  for (const [label, value] of extraRows) {
    rows.push([escapeCsvCell(label), escapeCsvCell(value)]);
  }
  rows.push(
    [escapeCsvCell('Source Scope'), escapeCsvCell(source.scope)],
    [escapeCsvCell('Source Description'), escapeCsvCell(source.scopeLabel)],
    [escapeCsvCell('Data Freshness'), escapeCsvCell(source.freshnessLabel)],
  );
  for (const note of notes) {
    rows.push([escapeCsvCell('Note'), escapeCsvCell(note)]);
  }
  return rows;
}

// Integer minor units -> a fixed two-decimal-place dollar string (e.g.
// 123456 -> "1234.56"), computed with integer arithmetic only — never
// floating-point division — so the result is exact and never silently
// drops a trailing zero. Kept local: apps/api and apps/web share no
// source, and this is one line of arithmetic, not worth a shared package.
function minorUnitsToDecimalString(minorUnits: number): string {
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${whole}.${String(cents).padStart(2, '0')}`;
}

const ORDER_STATUS_ORDER: readonly OrderStatus[] = [
  'RECEIVED',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'COMPLETED',
];

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: 'Received',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Completed',
};

// Milestone 9A — Digital Sales & Orders. Not tabular in the JSON, so the
// CSV is a metadata block followed by two small key/value sections
// (summary metrics, then the status breakdown) — no transaction-level
// rows are invented; only what the report result already exposes.
export function ordersOverviewCsvRows(
  report: AdminOrdersOverviewReport,
): string[][] {
  const locationLabel = report.location
    ? report.location.name
    : 'All locations';

  return [
    ...metadataRows(
      'Digital Sales & Orders',
      report.filters,
      [['Location', locationLabel]],
      report.source,
      [],
    ),
    BLANK_ROW,
    [escapeCsvCell('Metric'), escapeCsvCell('Value')],
    [escapeCsvCell('Total Orders'), numericCsvCell(report.totalOrders)],
    [
      escapeCsvCell('Completed Orders'),
      numericCsvCell(report.completedOrders),
    ],
    [
      escapeCsvCell('Digital Sales (USD)'),
      numericCsvCell(minorUnitsToDecimalString(report.digitalSalesMinorUnits)),
    ],
    [
      escapeCsvCell('Average Order Value (USD)'),
      numericCsvCell(
        minorUnitsToDecimalString(report.averageOrderValueMinorUnits),
      ),
    ],
    BLANK_ROW,
    [escapeCsvCell('Order Status'), escapeCsvCell('Count')],
    ...ORDER_STATUS_ORDER.map((status) => [
      escapeCsvCell(ORDER_STATUS_LABEL[status]),
      numericCsvCell(report.statusBreakdown[status]),
    ]),
  ];
}

// Milestone 9B — Location Performance. Naturally tabular: metadata block
// (with the Completed % caveat as a Note row, exact UI wording), then one
// header row + one row per location, in the exact order the report
// result already returned (name-ascending, id-tiebreak — never
// re-sorted, never ranked here).
export function locationPerformanceCsvRows(
  report: AdminLocationPerformanceReport,
): string[][] {
  return [
    ...metadataRows(
      'Location Performance',
      report.filters,
      [],
      report.source,
      [
        'Completed % reflects orders whose current status is Completed. Orders still in progress lower this figure, so it is most meaningful for a period that has already ended.',
      ],
    ),
    BLANK_ROW,
    [
      escapeCsvCell('Location'),
      escapeCsvCell('Active'),
      escapeCsvCell('Digital Ordering Enabled'),
      escapeCsvCell('Total Orders'),
      escapeCsvCell('Completed Orders'),
      escapeCsvCell('Completed %'),
      escapeCsvCell('Digital Sales (USD)'),
      escapeCsvCell('Average Order Value (USD)'),
    ],
    ...report.locations.map((row) => [
      escapeCsvCell(row.locationName),
      escapeCsvCell(row.isActive ? 'Yes' : 'No'),
      escapeCsvCell(row.isDigitalOrderingEnabled ? 'Yes' : 'No'),
      numericCsvCell(row.totalOrders),
      numericCsvCell(row.completedOrders),
      numericCsvCell(row.completedPercent),
      numericCsvCell(minorUnitsToDecimalString(row.digitalSalesMinorUnits)),
      numericCsvCell(
        minorUnitsToDecimalString(row.averageOrderValueMinorUnits),
      ),
    ]),
  ];
}

// Milestone 9C — Operations Checklist Visibility. Naturally tabular, same
// shape as 9B, with BOTH existing UI caveats preserved as Note rows
// (verbatim wording) — no percentages, no missed/compliance metric, none
// of that is invented here either.
export function operationsChecklistCsvRows(
  report: AdminOperationsChecklistReport,
): string[][] {
  return [
    ...metadataRows(
      'Operations Checklist Visibility',
      report.filters,
      [],
      report.source,
      [
        'Checklist instances are created when staff access a checklist. No recorded activity does not necessarily mean a checklist was missed.',
        'Current Exceptions reflects exceptions still recorded on checklist items. Exceptions that were later cleared are not included.',
      ],
    ),
    BLANK_ROW,
    [
      escapeCsvCell('Location'),
      escapeCsvCell('Active'),
      escapeCsvCell('Opening Started'),
      escapeCsvCell('Opening Completed'),
      escapeCsvCell('Opening Current Exceptions'),
      escapeCsvCell('Closing Started'),
      escapeCsvCell('Closing Completed'),
      escapeCsvCell('Closing Current Exceptions'),
    ],
    ...report.locations.map((row) => [
      escapeCsvCell(row.locationName),
      escapeCsvCell(row.isActive ? 'Yes' : 'No'),
      numericCsvCell(row.openingStarted),
      numericCsvCell(row.openingCompleted),
      numericCsvCell(row.openingCurrentExceptions),
      numericCsvCell(row.closingStarted),
      numericCsvCell(row.closingCompleted),
      numericCsvCell(row.closingCurrentExceptions),
    ]),
  ];
}

// Milestone 9D — Customer Growth & Ordering. Summary-card based, so the
// CSV is a metadata block (with both existing UI disclosures as Note
// rows, verbatim wording) followed by a plain Metric,Value block — the
// exact six existing counters, no customer-level data.
export function customerGrowthCsvRows(
  report: AdminCustomerGrowthReport,
): string[][] {
  return [
    ...metadataRows(
      'Customer Growth & Ordering',
      report.filters,
      [],
      report.source,
      [
        'Repeat Registered Customers means registered customers with two or more digital orders during the selected period — not a second lifetime purchase or a returning customer from a prior period.',
        'Order-based figures include digital-platform orders only. In-store/POS transactions are not included.',
      ],
    ),
    BLANK_ROW,
    [escapeCsvCell('Metric'), escapeCsvCell('Value')],
    [
      escapeCsvCell('Registered Customers as of End Date'),
      numericCsvCell(report.registeredCustomersAsOfEndDate),
    ],
    [
      escapeCsvCell('New Registered Customers'),
      numericCsvCell(report.newRegisteredCustomers),
    ],
    [
      escapeCsvCell('Registered Customers With Orders'),
      numericCsvCell(report.registeredCustomersWithOrders),
    ],
    [
      escapeCsvCell('Repeat Registered Customers'),
      numericCsvCell(report.repeatRegisteredCustomers),
    ],
    [
      escapeCsvCell('Registered Customer Orders'),
      numericCsvCell(report.registeredCustomerOrders),
    ],
    [escapeCsvCell('Guest Orders'), numericCsvCell(report.guestOrders)],
  ];
}
