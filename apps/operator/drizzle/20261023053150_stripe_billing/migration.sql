CREATE TABLE "payouts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payouts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" varchar(64) NOT NULL,
	"amountCents" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"stripeTransferId" varchar(255) UNIQUE,
	"reversedCents" bigint DEFAULT 0 NOT NULL,
	"failureReason" varchar(1024),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" varchar(255) PRIMARY KEY,
	"type" varchar(255) NOT NULL,
	"processedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "top_ups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "top_ups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" varchar(64) NOT NULL,
	"amountMicroUsd" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"checkoutSessionId" varchar(255) UNIQUE,
	"paymentIntentId" varchar(255) UNIQUE,
	"refundedMicroUsd" bigint DEFAULT 0 NOT NULL,
	"disputedMicroUsd" bigint DEFAULT 0 NOT NULL,
	"createdBy" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "topUpId" integer;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "payoutId" integer;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "stripeObjectId" varchar(255);--> statement-breakpoint
CREATE INDEX "payouts_organizationId_index" ON "payouts" ("organizationId");--> statement-breakpoint
CREATE INDEX "payouts_status_index" ON "payouts" ("status");--> statement-breakpoint
CREATE INDEX "top_ups_organizationId_index" ON "top_ups" ("organizationId");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_topUpId_top_ups_id_fkey" FOREIGN KEY ("topUpId") REFERENCES "top_ups"("id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payoutId_payouts_id_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "top_ups" ADD CONSTRAINT "top_ups_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");