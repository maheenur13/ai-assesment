-- Bulk import reports (Task 3).
CREATE TABLE "import_runs" (
    "id" UUID NOT NULL,
    "source_url" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL,
    "mapping" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_runs_created_at_id_idx" ON "import_runs"("created_at", "id");
