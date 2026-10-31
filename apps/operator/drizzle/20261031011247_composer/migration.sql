CREATE TABLE "composer_charges" (
	"id" uuid PRIMARY KEY,
	"organizationId" varchar(64) NOT NULL,
	"userId" text NOT NULL,
	"conversationId" uuid,
	"status" varchar(16) DEFAULT 'held' NOT NULL,
	"holdMicroUsd" bigint NOT NULL,
	"inputTokens" bigint,
	"cacheWriteTokens" bigint,
	"cacheReadTokens" bigint,
	"outputTokens" bigint,
	"amountMicroUsd" bigint,
	"expiresAt" timestamp NOT NULL,
	"capturedAt" timestamp,
	"releasedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composer_conversations" (
	"id" uuid PRIMARY KEY,
	"organizationId" varchar(64) NOT NULL,
	"userId" text NOT NULL,
	"title" varchar(255) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composer_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "composer_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversationId" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "composerChargeId" uuid;--> statement-breakpoint
CREATE INDEX "composer_charges_organizationId_index" ON "composer_charges" ("organizationId");--> statement-breakpoint
CREATE INDEX "composer_charges_status_expiresAt_index" ON "composer_charges" ("status","expiresAt");--> statement-breakpoint
CREATE INDEX "composer_conversations_userId_organizationId_updatedAt_index" ON "composer_conversations" ("userId","organizationId","updatedAt");--> statement-breakpoint
CREATE INDEX "composer_messages_conversationId_index" ON "composer_messages" ("conversationId");--> statement-breakpoint
ALTER TABLE "composer_charges" ADD CONSTRAINT "composer_charges_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "composer_charges" ADD CONSTRAINT "composer_charges_conversationId_composer_conversations_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "composer_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "composer_conversations" ADD CONSTRAINT "composer_conversations_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "composer_messages" ADD CONSTRAINT "composer_messages_conversationId_composer_conversations_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "composer_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_composerChargeId_composer_charges_id_fkey" FOREIGN KEY ("composerChargeId") REFERENCES "composer_charges"("id");