-- Product Modifier Management — the database's own bounds on modifier
-- groups and options, the same first-launch rules the API enforces:
--   * names: 1–120 characters, not blank, no surrounding spaces;
--   * minimum selections 0–20; "required" exactly when the minimum is >= 1;
--   * maximum selections: none (no limit) or from max(minimum, 1) to 20;
--   * option price adjustments: 0 to 10000 cents ($0–$100), never negative.
--
-- ADDITIVE ONLY: four CHECK constraints. No row is changed. A read-only
-- preflight first counts every existing row that breaks a rule and, if any
-- does, stops with the counts per rule before anything is added — existing
-- data is never repaired or rewritten by this migration.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261114090000_modifier_value_checks.down.sql.

DO $modifier_value_checks$
DECLARE
  bad_group_names bigint;
  bad_group_selections bigint;
  bad_group_required bigint;
  bad_option_names bigint;
  bad_option_prices bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  -- No concurrent writes between the preflight and the constraints.
  LOCK TABLE "ModifierGroup", "ModifierOption" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) FROM "ModifierGroup"
    WHERE NOT (char_length("name") BETWEEN 1 AND 120
               AND "name" = btrim("name") AND btrim("name") <> '')
    INTO bad_group_names;
  SELECT count(*) FROM "ModifierGroup"
    WHERE NOT ("minSelections" BETWEEN 0 AND 20
               AND ("maxSelections" IS NULL
                    OR "maxSelections" BETWEEN GREATEST("minSelections", 1) AND 20))
    INTO bad_group_selections;
  SELECT count(*) FROM "ModifierGroup"
    WHERE "isRequired" <> ("minSelections" >= 1)
    INTO bad_group_required;
  SELECT count(*) FROM "ModifierOption"
    WHERE NOT (char_length("name") BETWEEN 1 AND 120
               AND "name" = btrim("name") AND btrim("name") <> '')
    INTO bad_option_names;
  SELECT count(*) FROM "ModifierOption"
    WHERE NOT ("priceAdjustment" BETWEEN 0 AND 10000)
    INTO bad_option_prices;

  IF bad_group_names + bad_group_selections + bad_group_required
     + bad_option_names + bad_option_prices > 0 THEN
    RAISE EXCEPTION 'Modifier value checks refused: existing rows break the rules (group names: %, group selection limits: %, group required/minimum mismatch: %, option names: %, option price adjustments: %). Fix them explicitly first. Nothing was changed.',
      bad_group_names, bad_group_selections, bad_group_required,
      bad_option_names, bad_option_prices;
  END IF;

  ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 120
           AND "name" = btrim("name") AND btrim("name") <> '');
  ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_selections_check"
    CHECK ("minSelections" BETWEEN 0 AND 20
           AND "isRequired" = ("minSelections" >= 1)
           AND ("maxSelections" IS NULL
                OR "maxSelections" BETWEEN GREATEST("minSelections", 1) AND 20));
  ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 120
           AND "name" = btrim("name") AND btrim("name") <> '');
  ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_priceAdjustment_check"
    CHECK ("priceAdjustment" BETWEEN 0 AND 10000);
END
$modifier_value_checks$;
