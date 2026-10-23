-- Escrow-era receipts were settled on Solana and have no organizations, so they are dropped with the Solana settlement model.
DELETE FROM "receipts";--> statement-breakpoint
CREATE TABLE "enrollment_tokens" (
	"tokenHash" varchar(64) PRIMARY KEY,
	"organizationId" varchar(64) NOT NULL,
	"label" varchar(255),
	"createdBy" varchar(255),
	"expiresAt" timestamp NOT NULL,
	"usedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"transactionId" uuid NOT NULL,
	"account" varchar(128) NOT NULL,
	"amountMicroUsd" bigint NOT NULL,
	"kind" varchar(32) NOT NULL,
	"receiptId" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"publicKey" varchar(255) PRIMARY KEY,
	"organizationId" varchar(64) NOT NULL,
	"label" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(64) PRIMARY KEY,
	"clerkOrgId" varchar(255) UNIQUE,
	"name" varchar(255) NOT NULL,
	"stripeCustomerId" varchar(255) UNIQUE,
	"stripeAccountId" varchar(255) UNIQUE,
	"payoutsEnabled" boolean DEFAULT false NOT NULL,
	"balanceMicroUsd" bigint DEFAULT 0 NOT NULL,
	"heldMicroUsd" bigint DEFAULT 0 NOT NULL,
	"payableMicroUsd" bigint DEFAULT 0 NOT NULL,
	"frozenAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipts" DROP CONSTRAINT "receipts_settlementId_settlements_id_fkey";--> statement-breakpoint
DROP TABLE "settlements";--> statement-breakpoint
DROP INDEX "receipts_publicKey_index";--> statement-breakpoint
DROP INDEX "receipts_settlementId_index";--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "payerOrganizationId" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "payerPublicKey" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "recipientOrganizationId" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "providerPublicKey" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "status" varchar(16) DEFAULT 'held' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "heldMicroUsd" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "amountMicroUsd" bigint;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "feeMicroUsd" bigint;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "capturedAt" timestamp;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "releasedAt" timestamp;--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "amount";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "recipientAddress";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "publicKey";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "maxAmount";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "settlementId";--> statement-breakpoint
CREATE INDEX "ledger_entries_account_index" ON "ledger_entries" ("account");--> statement-breakpoint
CREATE INDEX "ledger_entries_transactionId_index" ON "ledger_entries" ("transactionId");--> statement-breakpoint
CREATE INDEX "nodes_organizationId_index" ON "nodes" ("organizationId");--> statement-breakpoint
CREATE INDEX "receipts_payerOrganizationId_index" ON "receipts" ("payerOrganizationId");--> statement-breakpoint
CREATE INDEX "receipts_recipientOrganizationId_index" ON "receipts" ("recipientOrganizationId");--> statement-breakpoint
CREATE INDEX "receipts_status_expiresAt_index" ON "receipts" ("status","expiresAt");--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_receiptId_receipts_id_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payerOrganizationId_organizations_id_fkey" FOREIGN KEY ("payerOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_recipientOrganizationId_organizations_id_fkey" FOREIGN KEY ("recipientOrganizationId") REFERENCES "organizations"("id");