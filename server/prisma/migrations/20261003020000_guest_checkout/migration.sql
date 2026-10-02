-- Guest checkout through the assistant: guests are customers without a token.
ALTER TABLE "customers" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false,
    ALTER COLUMN "token_hash" DROP NOT NULL,
    ALTER COLUMN "token_prefix" DROP NOT NULL,
    -- Registered customers always have a token; guests never do.
    ADD CONSTRAINT "customers_guest_token_check" CHECK ("is_guest" = ("token_hash" IS NULL));

-- Email is unique among registered customers only: a guest may use any address, and using a
-- registered customer's address gives no access to that customer.
DROP INDEX "customers_email_key";
CREATE UNIQUE INDEX "customers_email_registered_key" ON "customers"("email") WHERE NOT "is_guest";

ALTER TABLE "conversations" ADD COLUMN "guest_customer_id" UUID;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_guest_customer_id_fkey" FOREIGN KEY ("guest_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A conversation belongs either to a signed-in customer or (anonymous) to at most one guest.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_check" CHECK ("customer_id" IS NULL OR "guest_customer_id" IS NULL);
