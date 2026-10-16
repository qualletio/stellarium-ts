ALTER TABLE "receipts" ADD COLUMN "status" varchar(16) DEFAULT 'unconfirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "lastValidBlockHeight" bigint;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ALTER COLUMN "amount" SET DATA TYPE bigint USING "amount"::bigint;