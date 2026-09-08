import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getGiftCardDetail } from "@/lib/internal-auth/admin-gift-cards";
import { can } from "@/lib/admin/capabilities";
import { formatPrice } from "@/lib/money";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { Card } from "@/components/Card";
import { GiftCardTabs } from "@/components/admin/GiftCardTabs";
import { GiftCardSearchPanel } from "@/components/admin/GiftCardSearchPanel";
import { GiftCardIssuePanel } from "@/components/admin/GiftCardIssuePanel";
import { GiftCardCorrectionForm } from "@/components/admin/GiftCardCorrectionForm";
import { GiftCardStatusControl } from "@/components/admin/GiftCardStatusControl";
import type { GiftCardTransactionType } from "@mocha-house/contracts";

const LEDGER_TYPE_LABEL: Record<GiftCardTransactionType, string> = {
  ISSUANCE: "Issued",
  ADJUSTMENT: "Manual correction",
};

// Admin → Gift Cards (Milestone 7F). The HQ financial + administrative
// foundation: issue a gift card for a legitimate administrative reason,
// look one up by its secure code or id, read its balance and the immutable
// transaction ledger, deactivate / reactivate it, and make an authorized
// manual balance correction. NOT customer purchasing or checkout
// redemption. Every permission is CORPORATE-only and the API enforces it;
// the checks here just keep the page out of the way. The selected card id
// lives in the URL (refresh-safe); the secure code never does.
export default async function AdminGiftCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string | string[] }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const canView = can(caps, "giftcards.view");
  const canManage = can(caps, "giftcards.manage");
  const canConfigure = can(caps, "giftcards.configure");

  const header = (
    <AdminPageHeader
      title="Gift Cards"
      description="Issue, look up and correct Mocha House gift cards."
      breadcrumbs={[{ label: "Gift Cards" }]}
    />
  );

  if (!canView && !canManage) {
    // A configuration-only user has no card access; send them to the part
    // of Gift Cards they can use.
    if (canConfigure) {
      redirect("/admin/gift-cards/configuration");
    }
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const params = await searchParams;
  const selectedId = Array.isArray(params.selected)
    ? params.selected[0]
    : params.selected;

  return (
    <AdminPage>
      {header}
      <GiftCardTabs
        active="gift-cards"
        canViewOrManage={canView || canManage}
        canConfigure={canConfigure}
      />

      {canManage ? (
        <AdminSection
          title="Issue a gift card"
          description="For a legitimate HQ reason — a complimentary card, a customer-service recovery, or testing. The full code is shown once."
        >
          <GiftCardIssuePanel />
        </AdminSection>
      ) : null}

      <AdminSection
        title="Find a gift card"
        description="Enter the full gift-card code or a gift-card id."
      >
        <GiftCardSearchPanel selectedId={selectedId} />
      </AdminSection>

      {selectedId ? (
        <GiftCardDetail
          giftCardId={selectedId}
          canManage={canManage}
        />
      ) : null}
    </AdminPage>
  );
}

async function GiftCardDetail({
  giftCardId,
  canManage,
}: {
  giftCardId: string;
  canManage: boolean;
}) {
  const result = await getGiftCardDetail(giftCardId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return <AdminForbidden />;
  }
  if (result.outcome === "not-found") {
    return (
      <AdminNotFound
        title="Gift card not found"
        description="This gift card no longer exists."
        backHref="/admin/gift-cards"
        backLabel="Back to Gift Cards"
      />
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminErrorState description="Couldn't load that gift card just now. Please try again." />
    );
  }

  const { giftCard, transactions } = result.data;

  return (
    <AdminSection title="Gift card">
      <Card className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-base font-semibold tracking-wider text-text-primary">
            {giftCard.maskedCode}
          </span>
          <span className="text-xs text-text-muted">
            {giftCard.id} ·{" "}
            <span
              className={
                giftCard.status === "ACTIVE"
                  ? "text-status-success"
                  : "text-status-warning"
              }
            >
              {giftCard.status === "ACTIVE" ? "Active" : "Inactive"}
            </span>
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-2xl font-semibold tracking-tight text-text-primary">
            {formatPrice(giftCard.balanceMinorUnits, giftCard.currency)}
          </span>
          <span className="text-xs text-text-muted">
            of{" "}
            {formatPrice(giftCard.originalValueMinorUnits, giftCard.currency)}{" "}
            issued
          </span>
        </div>
      </Card>

      {canManage ? (
        <div className="flex flex-col gap-4">
          <GiftCardStatusControl
            giftCardId={giftCard.id}
            status={giftCard.status}
          />
          <GiftCardCorrectionForm
            giftCardId={giftCard.id}
            currentBalanceMinorUnits={giftCard.balanceMinorUnits}
            currency={giftCard.currency}
          />
        </div>
      ) : (
        <p className="text-sm text-text-muted">
          You have view-only access to gift cards. Issuing, correcting and
          deactivating require the gift-card management permission.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-primary">
          Transaction ledger
        </h3>
        {transactions.length === 0 ? (
          <p className="text-sm text-text-muted">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-default text-left text-xs text-text-muted">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 pr-3 text-right font-medium">Balance</th>
                  <th className="py-2 pr-3 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-border-default/60 align-top"
                  >
                    <td className="py-2 pr-3 text-text-secondary">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-text-secondary">
                      {LEDGER_TYPE_LABEL[entry.type]}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-medium ${
                        entry.amountMinorUnits < 0
                          ? "text-status-warning"
                          : "text-text-primary"
                      }`}
                    >
                      {entry.amountMinorUnits > 0 ? "+" : ""}
                      {formatPrice(entry.amountMinorUnits, giftCard.currency)}
                    </td>
                    <td className="py-2 pr-3 text-right text-text-secondary">
                      {formatPrice(
                        entry.balanceAfterMinorUnits,
                        giftCard.currency,
                      )}
                    </td>
                    <td className="py-2 pr-3 text-text-secondary">
                      {entry.reason ?? ""}
                      {entry.actorLabel ? ` — ${entry.actorLabel}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminSection>
  );
}
