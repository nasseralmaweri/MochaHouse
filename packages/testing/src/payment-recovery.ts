import { Client } from "pg";
import { assertDisposableDatabase } from "./disposable-database";

// TEST-ONLY (ESP-03 PR 4). Removes the payment-recovery records of the given
// payment attempts — their saved checkouts (CheckoutSnapshot), their
// financial holds (ESP-03 PR 8) and their
// reconciliation cases with their event history and support notes (ESP-03
// PR 5) — so a suite can delete the
// payment attempts it created afterwards.
//
// Reconciliation events are append-only on purpose (a database trigger
// refuses every UPDATE and DELETE), and a case cannot go while its events
// remain. This helper therefore turns ordinary triggers off for ONE
// transaction with session_replication_role = replica, which needs a
// superuser (the disposable CI / local test role). It refuses to run against
// anything but a verified disposable test database, and it never belongs in
// application code: it is exactly the bypass production roles must not have.
export async function removePaymentRecoveryRecordsForTest(
  paymentAttemptIds: readonly string[],
  url: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  if (paymentAttemptIds.length === 0) return;
  await assertDisposableDatabase(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const ids = [...paymentAttemptIds];
    await client.query(
      `DELETE FROM "CheckoutSnapshot" WHERE "paymentAttemptId" = ANY($1::text[])`,
      [ids],
    );
    // ESP-03 PR 8 — financial holds are never deleted (a trigger refuses).
    await client.query(
      `DELETE FROM "FinancialHold" WHERE "paymentAttemptId" = ANY($1::text[])`,
      [ids],
    );
    await client.query(
      `DELETE FROM "PaymentReconciliationNote" WHERE "caseId" IN (
         SELECT id FROM "PaymentReconciliationCase" WHERE "paymentAttemptId" = ANY($1::text[]))`,
      [ids],
    );
    await client.query(
      `DELETE FROM "PaymentReconciliationEvent" WHERE "caseId" IN (
         SELECT id FROM "PaymentReconciliationCase" WHERE "paymentAttemptId" = ANY($1::text[]))`,
      [ids],
    );
    await client.query(
      `DELETE FROM "PaymentReconciliationCase" WHERE "paymentAttemptId" = ANY($1::text[])`,
      [ids],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

// TEST-ONLY (ESP-03 PR 8). Removes the financial holds that reference any of
// the given promotions, gift cards or customers (and those customers' loyalty
// accounts), or every hold of the given businesses, so a suite can delete the promotions, cards and customers it
// created. Holds are never deleted in production (a trigger refuses); like
// removePaymentRecoveryRecordsForTest this turns triggers off for ONE
// transaction and runs only against a verified disposable test database.
export async function removeFinancialHoldsForTest(
  refs: {
    promotionIds?: readonly string[];
    giftCardIds?: readonly string[];
    customerIds?: readonly string[];
    tenantIds?: readonly string[];
  },
  url: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  const promotionIds = [...(refs.promotionIds ?? [])];
  const giftCardIds = [...(refs.giftCardIds ?? [])];
  const customerIds = [...(refs.customerIds ?? [])];
  const tenantIds = [...(refs.tenantIds ?? [])];
  if (
    promotionIds.length +
      giftCardIds.length +
      customerIds.length +
      tenantIds.length ===
    0
  ) {
    return;
  }
  await assertDisposableDatabase(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM "FinancialHold"
        WHERE "promotionId" = ANY($1::text[])
           OR "giftCardId" = ANY($2::text[])
           OR "customerId" = ANY($3::text[])
           OR "loyaltyAccountId" IN (
             SELECT id FROM "CustomerLoyaltyAccount" WHERE "customerId" = ANY($3::text[]))
           OR "tenantId" = ANY($4::text[])`,
      [promotionIds, giftCardIds, customerIds, tenantIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

// TEST-ONLY (ESP-04 M1). Removes the restaurant payment accounts of the given
// businesses and the Connect webhook events naming the given connected
// accounts, so a suite can clean up after itself. A payment account record is
// never deleted in production (a trigger refuses); like the helpers above
// this turns triggers off for ONE transaction and runs only against a
// verified disposable test database.
export async function removePaymentAccountsForTest(
  refs: {
    tenantIds?: readonly string[];
    externalAccountIds?: readonly string[];
    externalEventIds?: readonly string[];
  },
  url: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  const tenantIds = [...(refs.tenantIds ?? [])];
  const accountIds = [...(refs.externalAccountIds ?? [])];
  const eventIds = [...(refs.externalEventIds ?? [])];
  if (tenantIds.length + accountIds.length + eventIds.length === 0) return;
  await assertDisposableDatabase(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM "RestaurantPaymentProviderEvent"
        WHERE "externalAccountId" = ANY($1::text[])
           OR "externalEventId" = ANY($2::text[])
           OR "externalAccountId" IN (
             SELECT "externalAccountId" FROM "TenantPaymentAccount"
              WHERE "tenantId" = ANY($3::text[]))`,
      [accountIds, eventIds, tenantIds],
    );
    await client.query(
      `DELETE FROM "TenantPaymentAccount"
        WHERE "tenantId" = ANY($1::text[]) OR "externalAccountId" = ANY($2::text[])`,
      [tenantIds, accountIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
