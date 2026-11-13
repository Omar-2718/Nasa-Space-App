-- Patches covering farms/roads
ALTER TABLE "patches" ADD COLUMN "modern" BOOLEAN NOT NULL DEFAULT false;
