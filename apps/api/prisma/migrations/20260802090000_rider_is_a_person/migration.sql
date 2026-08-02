-- A rider stops being one shop's staff and becomes a person who carries for several.
--
-- The village model needs one rider to take the cooked-food shop's parcels and the
-- grocer's on the same trip. An Order belongs to exactly one shop, so that can only be
-- expressed above the order: the rider is the shared thing, and `rider_shops` says which
-- shops they carry for.
--
-- Order of operations matters here and is not rearrangeable:
--   * the join table is filled BEFORE `riders.tenantId` is dropped, because that column is
--     the only record of who employed whom;
--   * orders are repointed BEFORE duplicate riders are deleted, because
--     `orders.riderId` is ON DELETE SET NULL — deleting first would silently erase who
--     carried those deliveries, which is exactly the record you need on the day something
--     goes wrong.

-- ── refuse to guess who is who ──────────────────────────────────────────────────────────
-- Below, riders sharing a phone number are collapsed into one row, because that is what a
-- shared phone almost always means: the same person, entered twice by two shops.
--
-- Almost. A placeholder number typed into three shops is three DIFFERENT people, and
-- merging them would fuse their deliveries now and their cash later — silently, and with
-- no way back. There is no rule that can tell the two cases apart, so this refuses to
-- decide: same phone AND same name merges, anything else stops the deploy and says so.
-- A migration that halts with an explanation is worth a great deal more than one that
-- quietly picks wrong.
DO $$
DECLARE shared text;
BEGIN
  SELECT string_agg(phone, ', ') INTO shared
  FROM (SELECT phone FROM "riders" GROUP BY phone HAVING count(DISTINCT name) > 1) d;

  IF shared IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE =
      'Refusing to merge riders: phone number(s) ' || shared || ' are shared by people with '
      || 'different names. A rider is about to become one person identified by their phone, '
      || 'so merging these would join two people''s deliveries into one record. Give them '
      || 'distinct phone numbers, then deploy again.';
  END IF;
END $$;

-- ── the join table ──────────────────────────────────────────────────────────────────────
CREATE TABLE "rider_shops" (
    "riderId"    UUID NOT NULL,
    "tenantId"   UUID NOT NULL,
    "approved"   BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rider_shops_pkey" PRIMARY KEY ("riderId","tenantId")
);

CREATE INDEX "rider_shops_tenantId_approved_idx" ON "rider_shops"("tenantId", "approved");

-- ── carry the existing relationships over, already approved ─────────────────────────────
-- These shops and riders already work together; nobody has to re-consent to a fact.
--
-- Same phone == same human, so riders duplicated across shops collapse onto one row. The
-- survivor is the oldest, which keeps the token that has been in that person's phone the
-- longest and is least likely to break a bookmark.
INSERT INTO "rider_shops" ("riderId", "tenantId", "approved", "approvedAt")
SELECT m.keeper, r."tenantId", true, CURRENT_TIMESTAMP
FROM "riders" r
JOIN (
  SELECT id, first_value(id) OVER (PARTITION BY phone ORDER BY "createdAt", id) AS keeper
  FROM "riders"
) m ON m.id = r.id
ON CONFLICT DO NOTHING;

-- ── deliveries follow the survivor ──────────────────────────────────────────────────────
UPDATE "orders" o
SET "riderId" = m.keeper
FROM (
  SELECT id, first_value(id) OVER (PARTITION BY phone ORDER BY "createdAt", id) AS keeper
  FROM "riders"
) m
WHERE o."riderId" = m.id AND m.keeper <> m.id;

-- ── and only then are the duplicates removed ────────────────────────────────────────────
DELETE FROM "riders" r
USING (
  SELECT id, first_value(id) OVER (PARTITION BY phone ORDER BY "createdAt", id) AS keeper
  FROM "riders"
) m
WHERE r.id = m.id AND m.keeper <> m.id;

-- ── a rider no longer belongs to a shop ─────────────────────────────────────────────────
DROP INDEX IF EXISTS "riders_tenantId_isActive_idx";
ALTER TABLE "riders" DROP CONSTRAINT IF EXISTS "riders_tenantId_fkey";
ALTER TABLE "riders" DROP COLUMN "tenantId";

-- One human, one row. This is what makes a rider's sheet, position and (later) cash add up
-- to one person instead of three unrelated records.
CREATE UNIQUE INDEX "riders_phone_key" ON "riders"("phone");
CREATE INDEX "riders_isActive_idx" ON "riders"("isActive");

-- ── join-table foreign keys, added last so nothing above has to be ordered around them ──
ALTER TABLE "rider_shops" ADD CONSTRAINT "rider_shops_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rider_shops" ADD CONSTRAINT "rider_shops_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
