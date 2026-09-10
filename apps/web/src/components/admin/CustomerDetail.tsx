import Link from "next/link";
import type { AdminCustomerDetail } from "@mocha-house/contracts";
import {
  activityLine,
  customerDisplayName,
  customerStatusLabel,
  customerStatusTone,
  emailVerifiedLabel,
  formatBeans,
  formatCrmDate,
  formatMinorUnits,
  marketingOptInLabel,
} from "@/lib/admin/crm";
import { Card } from "@/components/Card";
import { AdminSection } from "./AdminPage";
import { OrderStatusBadge, StatusBadge } from "./StatusBadge";
import { CustomerNotesPanel } from "./CustomerNotesPanel";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right text-text-primary">{value}</span>
    </div>
  );
}

// Admin → Customers → detail (Milestone 8A). Read-only presentation of the
// aggregated CRM view. Every section is an empty state when its source has
// nothing — never an error. Customer status and email verification are
// display-only; there are no account-management controls here.
export function CustomerDetail({
  detail,
  canManageNotes,
}: {
  detail: AdminCustomerDetail;
  canManageNotes: boolean;
}) {
  const { customer } = detail;

  return (
    <div className="flex flex-col gap-8">
      <AdminSection title="Profile">
        <Card className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-base font-semibold text-text-primary">
              {customerDisplayName(customer)}
            </span>
            <StatusBadge
              label={customerStatusLabel(customer.status)}
              tone={customerStatusTone(customer.status)}
            />
          </div>
          <Row label="Email" value={customer.email ?? "—"} />
          <Row
            label="Verification"
            value={emailVerifiedLabel(customer.emailVerified)}
          />
          <Row
            label="Marketing email"
            value={marketingOptInLabel(customer.marketingEmailOptIn)}
          />
          <Row label="Joined" value={formatCrmDate(customer.createdAt)} />
        </Card>
      </AdminSection>

      <AdminSection
        title="Orders"
        description={`${detail.orders.count} order${
          detail.orders.count === 1 ? "" : "s"
        } in total`}
      >
        {detail.orders.recent.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No orders yet.
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.orders.recent.map((order) => (
              <li key={order.orderId}>
                <Card className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-text-primary">
                      #{order.orderNumber}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {order.locationName} · {formatCrmDate(order.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-text-primary">
                      {formatMinorUnits(order.total, order.currency)}
                    </span>
                    <OrderStatusBadge status={order.status} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection
        title="Mocha Beans"
        description={`Balance: ${formatBeans(detail.mochaBeans.balance)}`}
      >
        {detail.mochaBeans.recentActivity.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No Mocha Bean activity yet.
          </Card>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.mochaBeans.recentActivity.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="text-text-secondary">
                  {entry.reason ?? entry.type}
                  {entry.orderNumber ? ` · #${entry.orderNumber}` : ""}
                </span>
                <span
                  className={
                    entry.amount >= 0
                      ? "text-status-success"
                      : "text-text-primary"
                  }
                >
                  {entry.amount >= 0 ? "+" : ""}
                  {formatBeans(entry.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection
        title="Rewards they can afford"
        description="Active rewards within this customer's current balance."
      >
        {detail.affordableRewards.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No rewards are currently within their balance.
          </Card>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {detail.affordableRewards.map((reward) => (
              <li
                key={reward.id}
                className="flex items-center justify-between gap-4"
              >
                <span className="text-text-primary">{reward.name}</span>
                <span className="text-text-secondary">
                  {formatBeans(reward.beanCost)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection title="Gift cards">
        {detail.giftCards.purchases.length === 0 &&
        detail.giftCards.redemptions.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No gift-card purchases or redemptions.
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {detail.giftCards.purchases.length > 0 ? (
              <Card className="flex flex-col gap-1.5 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Purchased
                </span>
                {detail.giftCards.purchases.map((purchase) => (
                  <div
                    key={purchase.purchaseId}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-text-primary">
                      {purchase.maskedCode ?? "Card pending"}
                    </span>
                    <span className="text-text-secondary">
                      {formatMinorUnits(
                        purchase.amountMinorUnits,
                        purchase.currency,
                      )}{" "}
                      · {formatCrmDate(purchase.createdAt)}
                    </span>
                  </div>
                ))}
              </Card>
            ) : null}
            {detail.giftCards.redemptions.length > 0 ? (
              <Card className="flex flex-col gap-1.5 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Redeemed at checkout
                </span>
                {detail.giftCards.redemptions.map((redemption) => (
                  <div
                    key={redemption.orderId}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-text-primary">
                      •••• {redemption.last4} · #{redemption.orderNumber}
                    </span>
                    <span className="text-text-secondary">
                      {formatMinorUnits(
                        redemption.amountMinorUnits,
                        redemption.currency,
                      )}{" "}
                      · {formatCrmDate(redemption.createdAt)}
                    </span>
                  </div>
                ))}
              </Card>
            ) : null}
          </div>
        )}
      </AdminSection>

      <AdminSection title="Preferred locations">
        {detail.preferredLocations.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No preferred locations saved.
          </Card>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-text-primary">
            {detail.preferredLocations.map((location) => (
              <li key={location.id}>{location.name}</li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection title="Communication preferences">
        <Card className="text-sm">
          <Row
            label="Marketing email"
            value={marketingOptInLabel(
              detail.communicationPreferences.marketingEmailOptIn,
            )}
          />
        </Card>
      </AdminSection>

      <AdminSection
        title="Internal notes"
        description="Staff-only. Append-only in this release."
      >
        <CustomerNotesPanel
          customerId={customer.id}
          initialNotes={detail.notes}
          canManage={canManageNotes}
        />
      </AdminSection>

      <AdminSection title="Activity">
        {detail.activity.length === 0 ? (
          <Card tone="subtle" className="text-sm text-text-secondary">
            No recorded HQ activity for this customer.
          </Card>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm text-text-secondary">
            {detail.activity.map((item) => (
              <li key={item.id}>{activityLine(item)}</li>
            ))}
          </ul>
        )}
      </AdminSection>

      <p className="text-xs text-text-muted">
        <Link
          href="/admin/customers"
          className="underline underline-offset-2"
        >
          Back to all customers
        </Link>
      </p>
    </div>
  );
}
