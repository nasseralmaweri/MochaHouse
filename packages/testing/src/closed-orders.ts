import { Client } from "pg";
import { assertDisposableDatabase } from "./disposable-database";

// TEST-ONLY (R1 / S5b). Puts an existing order into REJECTED / CANCELLED
// WITHOUT the closure workflow — no OrderClosure, no reversal, no refund
// obligation — so read-side suites (reports, the store queue) can count a
// closed order and still delete it afterwards.
//
// The database refuses this on purpose: an order cannot be inserted closed
// (S5b, Order_insert_not_closed) or become closed without a closure (S5a,
// Order_closure_required). This helper therefore turns ordinary triggers off
// for ONE transaction with session_replication_role = replica, which needs a
// superuser (the disposable CI / local test role). It refuses to run against
// anything but a verified disposable test database, and it never belongs in
// application code: it is exactly the bypass production roles must not have.
export async function markOrderClosedForTest(
  orderId: string,
  status: "REJECTED" | "CANCELLED",
  url: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  await assertDisposableDatabase(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const updated = await client.query(
      `UPDATE "Order" SET status = $2::"OrderStatus" WHERE id = $1`,
      [orderId, status],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`markOrderClosedForTest: order ${orderId} not found.`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
