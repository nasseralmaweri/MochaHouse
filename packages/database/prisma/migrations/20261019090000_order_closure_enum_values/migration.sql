-- R1 / S5a (part 1 of 3) — new enum values for order closure. ADDITIVE ONLY and
-- behaviour-neutral: no code writes any of these values yet (the closure writer
-- is S5b), so an application running before or after this migration behaves
-- identically.
--
--   "OrderStatus"             REJECTED, CANCELLED         (terminal, like COMPLETED)
--   "GiftCardTransactionType" REDEMPTION_REVERSAL
--   "MochaBeanEntryType"      REDEEM_REVERSAL, EARN_REVERSAL, BONUS_EARN_REVERSAL
--
-- Why a file of its own: PostgreSQL cannot USE a value added by ALTER TYPE ... ADD
-- VALUE in the same transaction that added it, so everything that references the
-- values (constraints, partial indexes, triggers) lives in the next migration,
-- 20261019090100_order_closure_foundation. ADD VALUE IF NOT EXISTS makes a re-run
-- after a partial failure harmless.
--
-- Cannot be undone: PostgreSQL has no ALTER TYPE ... DROP VALUE. The rollback is
-- "stop writing them" (see prisma/rollbacks/20261019090100_order_closure_foundation.down.sql).
-- A value that nothing writes is inert.
--
-- Deployment order (S5a): ship the application that understands the new statuses
-- (web labels, reports, contracts) BEFORE this migration is applied to a database a
-- writer could ever reach, and the writer (S5b) only after both.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "GiftCardTransactionType" ADD VALUE IF NOT EXISTS 'REDEMPTION_REVERSAL';
ALTER TYPE "MochaBeanEntryType" ADD VALUE IF NOT EXISTS 'REDEEM_REVERSAL';
ALTER TYPE "MochaBeanEntryType" ADD VALUE IF NOT EXISTS 'EARN_REVERSAL';
ALTER TYPE "MochaBeanEntryType" ADD VALUE IF NOT EXISTS 'BONUS_EARN_REVERSAL';
