import type { AdminOrdersOverviewReport } from '@mocha-house/contracts';
import { ordersOverviewCsvRows } from './report-csv-rows';

// R1 / S5a — the Digital Sales & Orders export with rejected / cancelled orders.
// Pure: only the typed report result goes in.

const report = (
  overrides: Partial<AdminOrdersOverviewReport['statusBreakdown']> = {},
): AdminOrdersOverviewReport => ({
  filters: { startDate: '2026-09-20', endDate: '2026-09-20', locationId: null },
  location: null,
  availableLocations: [],
  totalOrders: 2,
  completedOrders: 1,
  digitalSalesMinorUnits: 1500,
  averageOrderValueMinorUnits: 750,
  statusBreakdown: {
    RECEIVED: 1,
    ACCEPTED: 0,
    PREPARING: 0,
    READY: 0,
    COMPLETED: 1,
    REJECTED: 0,
    CANCELLED: 0,
    ...overrides,
  },
  source: {
    scope: 'DIGITAL_PLATFORM_ONLY',
    scopeLabel: 'Digital-platform orders only.',
    freshnessLabel: 'Live platform data',
  },
});

const cells = (rows: string[][]) => rows.map((row) => row.join(','));

describe('ordersOverviewCsvRows with closed orders', () => {
  it('lists Rejected and Cancelled in the status breakdown with their counts', () => {
    const lines = cells(
      ordersOverviewCsvRows(report({ REJECTED: 3, CANCELLED: 2 })),
    );
    expect(lines).toContain('Rejected,3');
    expect(lines).toContain('Cancelled,2');
    expect(lines).toContain('Completed,1');
  });

  it('explains that sales figures exclude closed orders — only when there are some', () => {
    const withClosed = cells(
      ordersOverviewCsvRows(report({ REJECTED: 1 })),
    ).join('\n');
    expect(withClosed).toMatch(/Note,.*exclude Rejected and Cancelled orders/);

    const withoutClosed = cells(ordersOverviewCsvRows(report())).join('\n');
    expect(withoutClosed).not.toMatch(/exclude Rejected and Cancelled/);
  });

  it('keeps the headline metrics exactly as the report states them', () => {
    const lines = cells(ordersOverviewCsvRows(report({ CANCELLED: 5 })));
    expect(lines).toContain('Total Orders,2');
    expect(lines).toContain('Digital Sales (USD),15.00');
    expect(lines).toContain('Average Order Value (USD),7.50');
  });
});
