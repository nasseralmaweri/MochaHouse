-- Product Modifier Management rollback for migration
-- 20261114090000_modifier_value_checks.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without Product Modifier Management.
--
-- It removes ONLY the four CHECK constraints the migration added (found by
-- their names on their tables); no row is read or changed. It REFUSES
-- (changing nothing) unless all four are present, so it can never
-- half-apply. One DO block, so it is atomic.

DO $modifier_value_checks_rollback$
DECLARE
  present bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "ModifierGroup", "ModifierOption" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'c'
      AND (t.relname, c.conname) IN (
        ('ModifierGroup', 'ModifierGroup_name_check'),
        ('ModifierGroup', 'ModifierGroup_selections_check'),
        ('ModifierOption', 'ModifierOption_name_check'),
        ('ModifierOption', 'ModifierOption_priceAdjustment_check'))
    INTO present;
  IF present <> 4 THEN
    RAISE EXCEPTION 'Modifier value checks rollback refused: expected the 4 constraints the migration added, found %. Nothing was changed.', present;
  END IF;

  ALTER TABLE "ModifierGroup" DROP CONSTRAINT "ModifierGroup_name_check";
  ALTER TABLE "ModifierGroup" DROP CONSTRAINT "ModifierGroup_selections_check";
  ALTER TABLE "ModifierOption" DROP CONSTRAINT "ModifierOption_name_check";
  ALTER TABLE "ModifierOption" DROP CONSTRAINT "ModifierOption_priceAdjustment_check";
END
$modifier_value_checks_rollback$;
