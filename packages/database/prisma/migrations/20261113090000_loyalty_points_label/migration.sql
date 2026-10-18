-- SC4f-3b — a business's own display name for its loyalty points (owner
-- decision J5). Presentation only: no balance, ledger entry, earning rule or
-- redemption changes.
--
-- ADDITIVE ONLY: one nullable column and its check. No existing row changes:
-- every business keeps showing what it shows today until it chooses a name
-- (the legacy business — identified by trusted configuration, never a
-- hardcoded id — keeps "Mocha Beans"; every other business shows "Points").
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261113090000_loyalty_points_label.down.sql.

ALTER TABLE "LoyaltyConfiguration" ADD COLUMN "pointsLabel" TEXT;
ALTER TABLE "LoyaltyConfiguration" ADD CONSTRAINT "LoyaltyConfiguration_pointsLabel_check"
  CHECK (
    "pointsLabel" IS NULL
    OR (
      char_length("pointsLabel") BETWEEN 1 AND 32
      AND "pointsLabel" = btrim("pointsLabel")
      AND "pointsLabel" !~ '[[:cntrl:]]'
    )
  );
