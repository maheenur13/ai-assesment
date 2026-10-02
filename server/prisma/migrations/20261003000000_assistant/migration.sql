-- Full-text search for the catalog assistant. A generated column keeps the vector in sync with
-- every write path (REST, seed, bulk import) without triggers or application code.
ALTER TABLE "products" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', "name"), 'A') ||
    setweight(to_tsvector('english', "category"), 'B') ||
    setweight(to_tsvector('english', "description"), 'C')
) STORED;

-- CreateIndex
CREATE INDEX "products_search_idx" ON "products" USING GIN ("search");

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "turn" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_customer_id_idx" ON "conversations"("customer_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
