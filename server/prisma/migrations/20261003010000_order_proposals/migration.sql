-- Order proposals for ordering through the assistant (Task 2): propose, then confirm.

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('pending', 'placed');

-- CreateTable
CREATE TABLE "order_proposals" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "created_turn" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'pending',
    "order_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_proposals_total_cents_check" CHECK ("total_cents" > 0),
    -- A placed proposal always points at its order.
    CONSTRAINT "order_proposals_placed_check" CHECK ("status" = 'pending' OR "order_id" IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "order_proposals_order_id_key" ON "order_proposals"("order_id");

-- CreateIndex
CREATE INDEX "order_proposals_customer_id_idx" ON "order_proposals"("customer_id");

-- AddForeignKey
ALTER TABLE "order_proposals" ADD CONSTRAINT "order_proposals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

