CREATE TABLE "audit_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"actor" varchar(255) NOT NULL,
	"action" varchar(64) NOT NULL,
	"organizationId" varchar(64),
	"details" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ban_appeals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ban_appeals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" varchar(64) NOT NULL,
	"bannedAt" timestamp NOT NULL,
	"statement" varchar(8192) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"createdBy" varchar(255),
	"decidedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ban_appeals_organizationId_bannedAt_unique" UNIQUE("organizationId","bannedAt")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoints_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"hash" varchar(64) NOT NULL,
	"summary" jsonb NOT NULL,
	"signature" varchar(255) NOT NULL,
	"publicKey" varchar(255) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_state_chain" (
	"nodePublicKey" varchar(255) NOT NULL,
	"name" varchar(512) NOT NULL,
	"variable" varchar(255) NOT NULL,
	"scopeKey" varchar(1024) NOT NULL,
	"version" bigint NOT NULL,
	"valueHash" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contract_state_chain_key_unique" UNIQUE("nodePublicKey","name","variable","scopeKey")
);
--> statement-breakpoint
CREATE TABLE "fraud_cases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fraud_cases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"rootRunId" integer NOT NULL,
	"organizationId" varchar(64) NOT NULL,
	"nodePublicKey" varchar(255) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"reason" varchar(4096) NOT NULL,
	"reversedMicroUsd" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_receipts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"rootRunId" integer NOT NULL,
	"nodePublicKey" varchar(255) NOT NULL,
	"signature" varchar(255) NOT NULL,
	"position" integer NOT NULL,
	"receipt" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "run_receipts_signature_position_unique" UNIQUE("signature","position")
);
--> statement-breakpoint
CREATE TABLE "staff_actions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "staff_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" varchar(32) NOT NULL,
	"organizationId" varchar(64),
	"payload" jsonb NOT NULL,
	"reason" varchar(4096) NOT NULL,
	"status" varchar(16) DEFAULT 'proposed' NOT NULL,
	"proposedBy" varchar(255) NOT NULL,
	"approvedBy" varchar(255),
	"decidedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_reviews" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verification_reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"rootRunId" integer NOT NULL,
	"nodePublicKey" varchar(255) NOT NULL,
	"reason" varchar(4096) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"decidedBy" varchar(255),
	"decidedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "suspendedAt" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "bannedAt" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "banReason" varchar(2048);--> statement-breakpoint
CREATE INDEX "audit_log_organizationId_index" ON "audit_log" ("organizationId");--> statement-breakpoint
CREATE INDEX "fraud_cases_organizationId_index" ON "fraud_cases" ("organizationId");--> statement-breakpoint
CREATE INDEX "run_receipts_rootRunId_index" ON "run_receipts" ("rootRunId");--> statement-breakpoint
CREATE INDEX "staff_actions_status_index" ON "staff_actions" ("status");--> statement-breakpoint
CREATE INDEX "verification_reviews_status_index" ON "verification_reviews" ("status");--> statement-breakpoint
ALTER TABLE "ban_appeals" ADD CONSTRAINT "ban_appeals_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "run_receipts" ADD CONSTRAINT "run_receipts_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "staff_actions" ADD CONSTRAINT "staff_actions_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "verification_reviews" ADD CONSTRAINT "verification_reviews_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");