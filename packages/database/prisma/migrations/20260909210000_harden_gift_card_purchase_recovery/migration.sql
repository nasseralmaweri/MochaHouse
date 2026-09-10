-- Milestone 7H corrections (post independent review).
--
-- (B) Guest recovery credential: a one-way HMAC-SHA-256 verifier of the
--     server-generated 256-bit recovery credential. Additive, nullable.
ALTER TABLE "GiftCardPurchase" ADD COLUMN "recoveryCredentialHash" TEXT;

-- (B) Step-2 charge claim: lets the two-step purchase protocol guarantee a
--     single payment-provider charge under concurrency. Additive, nullable.
ALTER TABLE "GiftCardPurchase" ADD COLUMN "chargeClaimedAt" TIMESTAMP(3);

-- (A) Cross-table PaymentAttempt XOR invariant: the original 7H triggers
--     fired BEFORE INSERT only, so an UPDATE of "paymentAttemptId" on either
--     table could still create a state where one PaymentAttempt backs both a
--     food Order AND a gift-card purchase. Recreate both triggers as
--     BEFORE INSERT OR UPDATE OF "paymentAttemptId". The trigger function is
--     unchanged (it already reads NEW."paymentAttemptId", which is correct
--     for UPDATE too) and is re-declared here only for self-containment.
CREATE OR REPLACE FUNCTION "assert_payment_attempt_single_domain"()
RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'Order' THEN
    IF EXISTS (
      SELECT 1 FROM "GiftCardPurchase" g
      WHERE g."paymentAttemptId" = NEW."paymentAttemptId"
    ) THEN
      RAISE EXCEPTION
        'PaymentAttempt % already backs a GiftCardPurchase and cannot also back an Order',
        NEW."paymentAttemptId" USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM "Order" o
      WHERE o."paymentAttemptId" = NEW."paymentAttemptId"
    ) THEN
      RAISE EXCEPTION
        'PaymentAttempt % already backs an Order and cannot also back a GiftCardPurchase',
        NEW."paymentAttemptId" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Order_single_payment_domain" ON "Order";
DROP TRIGGER IF EXISTS "GiftCardPurchase_single_payment_domain" ON "GiftCardPurchase";

CREATE TRIGGER "Order_single_payment_domain"
  BEFORE INSERT OR UPDATE OF "paymentAttemptId" ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "assert_payment_attempt_single_domain"();

CREATE TRIGGER "GiftCardPurchase_single_payment_domain"
  BEFORE INSERT OR UPDATE OF "paymentAttemptId" ON "GiftCardPurchase"
  FOR EACH ROW EXECUTE FUNCTION "assert_payment_attempt_single_domain"();
