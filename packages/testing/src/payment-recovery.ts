import { Client } from "pg";
import { assertDisposableDatabase } from "./disposable-database";

// TEST-ONLY (ESP-03 PR 4). Removes the payment-recovery records of the given
// payment attempts — their saved checkouts (CheckoutSnapshot) and their
// reconciliation cases with their event history — so a suite can delete the
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
