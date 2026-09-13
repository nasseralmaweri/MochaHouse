-- AlterTable
-- updatedAt backfills existing rows to now() via DEFAULT CURRENT_TIMESTAMP so
-- this migration is safe against a non-empty MediaAsset table; Prisma Client
-- (via @updatedAt in schema.prisma) sets it explicitly on every future
-- update regardless of this column-level default.
ALTER TABLE "MediaAsset" ADD COLUMN     "altText" TEXT,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
