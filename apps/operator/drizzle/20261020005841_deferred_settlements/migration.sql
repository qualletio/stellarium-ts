CREATE TABLE "settlements" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settlements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"publicKey" varchar(255) NOT NULL,
	"recipientAddress" varchar(255) NOT NULL,
	"amount" bigint NOT NULL,
	"transactionSignature" varchar(255) NOT NULL UNIQUE,
	"lastValidBlockHeight" bigint,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "settlementId" integer;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-written: each existing withdrawal becomes a settlement of its one receipt. Receipts whose
-- withdrawal failed or expired were never paid, so they stay unsettled and are paid by a later settlement.
UPDATE "receipts" SET "createdAt" = "updatedAt";--> statement-breakpoint
INSERT INTO "settlements" ("publicKey", "recipientAddress", "amount", "transactionSignature", "lastValidBlockHeight", "status", "createdAt", "updatedAt")
SELECT "publicKey", "recipientAddress", "amount", "transactionSignature", "lastValidBlockHeight", "status", "updatedAt", "updatedAt"
FROM "receipts" WHERE "status" NOT IN ('failed', 'expired');--> statement-breakpoint
UPDATE "receipts" SET "settlementId" = "settlements"."id"
FROM "settlements" WHERE "settlements"."transactionSignature" = "receipts"."transactionSignature";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "transactionSignature";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "lastValidBlockHeight";--> statement-breakpoint
CREATE INDEX "receipts_publicKey_index" ON "receipts" ("publicKey");--> statement-breakpoint
CREATE INDEX "receipts_settlementId_index" ON "receipts" ("settlementId");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_settlementId_settlements_id_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id");