-- Rows no reliable relationship can place (missing relationships): a
-- fixed-amount reward with no audit or redemption, and a gift card with no
-- purchase, transaction or audit event. Fictional data only.
INSERT INTO "LoyaltyReward"(id, name, type, "beanCost", "fixedAmountMinorUnits", "updatedAt") VALUES ('x-rw-orphan', 'Mystery', 'FIXED_AMOUNT', 10, 100, now());
INSERT INTO "GiftCard"(id, "codeHash", last4, "originalValueMinorUnits", "balanceMinorUnits", "updatedAt") VALUES ('x-gc-orphan', 'x-h', '9999', 500, 500, now());
