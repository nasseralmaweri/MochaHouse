// R1 / S5b — the explicit switch for order rejection and cancellation.
//
// OFF unless ORDER_CLOSURE_ENABLED is exactly "1". Anything else — unset, "0",
// "true", a typo — is OFF: closing an order moves stored value and creates a
// refund obligation, so an ambiguous setting fails closed. Read per request so
// switching it needs only a restart of the setting, never a code change.
//
// Enable it only after (1) every web client understands REJECTED / CANCELLED
// (S5a), (2) migration 20261020090000_order_closure_writer_guards is applied,
// and (3) `orders.cancel` has been granted to the people who should hold it.
export function isOrderClosureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ORDER_CLOSURE_ENABLED?.trim() === '1';
}
