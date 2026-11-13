-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "TagLabel" AS ENUM ('channel', 'site_feature', 'nothing', 'unsure');

-- CreateTable
CREATE TABLE "patches" (
    "id" TEXT NOT NULL,
    "tile" TEXT NOT NULL,
    "geom" geometry(Polygon, 4326) NOT NULL,
    "center" geometry(Point, 4326) NOT NULL,
    "tracer_line" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tracer_valley" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ai_score" DOUBLE PRECISION,
    "gold_label" "TagLabel",

    CONSTRAINT "patches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "trust" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" BIGSERIAL NOT NULL,
    "patch_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "label" "TagLabel" NOT NULL,
    "ms" INTEGER,
    "is_quiz" BOOLEAN NOT NULL DEFAULT false,
    "p_correct" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "age_text" TEXT,
    "note" TEXT,
    "confidence" TEXT NOT NULL,
    "source_url" TEXT,
    "geom" geometry(Point, 4326) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patches_geom_idx" ON "patches" USING GIST ("geom");

-- CreateIndex
CREATE INDEX "tags_patch_id_idx" ON "tags"("patch_id");

-- CreateIndex
CREATE INDEX "tags_session_id_idx" ON "tags"("session_id");

-- CreateIndex
CREATE INDEX "sites_geom_idx" ON "sites" USING GIST ("geom");

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_patch_id_fkey" FOREIGN KEY ("patch_id") REFERENCES "patches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Weighted crowd consensus per patch: votes count by session trust x tag reliability; flagged sessions and quiz answers are ignored.
CREATE VIEW consensus AS
SELECT p.id,
       count(t.id)                                                    AS votes,
       coalesce(sum(t.w) FILTER (WHERE t.label = 'channel'), 0)       AS w_channel,
       coalesce(sum(t.w) FILTER (WHERE t.label = 'site_feature'), 0)  AS w_site,
       coalesce(sum(t.w) FILTER (WHERE t.label = 'nothing'), 0)       AS w_nothing,
       CASE WHEN coalesce(sum(t.w) FILTER (WHERE t.label <> 'unsure'), 0) > 0
            THEN coalesce(sum(t.w) FILTER (WHERE t.label IN ('channel', 'site_feature')), 0)
                 / sum(t.w) FILTER (WHERE t.label <> 'unsure')
       END                                                            AS channel_share
FROM patches p
LEFT JOIN LATERAL (
  SELECT tg.label, s.trust * coalesce(tg.p_correct, 1) AS w, tg.id
  FROM tags tg JOIN sessions s ON s.id = tg.session_id
  WHERE tg.patch_id = p.id AND NOT s.flagged AND NOT tg.is_quiz
) t ON true
GROUP BY p.id;
