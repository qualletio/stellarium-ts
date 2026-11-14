CREATE TABLE "alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" varchar(32) NOT NULL,
	"nodePublicKey" varchar(255) NOT NULL,
	"organizationId" varchar(64),
	"details" jsonb NOT NULL,
	"acknowledgedBy" varchar(255),
	"acknowledgedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" varchar(64) NOT NULL,
	"kind" varchar(64) NOT NULL,
	"details" jsonb NOT NULL,
	"webhookAttempts" integer DEFAULT 0 NOT NULL,
	"webhookDeliveredAt" timestamp,
	"nextAttemptAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_flags" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_flags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"payeeOrganizationId" varchar(64) NOT NULL,
	"funderOrganizationId" varchar(64) NOT NULL,
	"rootRunId" integer NOT NULL,
	"reason" varchar(1024) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"clearedBy" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "random_requests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "random_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contractId" integer NOT NULL,
	"key" varchar(255) NOT NULL,
	"rootRunId" integer NOT NULL,
	"status" varchar(16) DEFAULT 'staged' NOT NULL,
	"value" varchar(64),
	"signature" varchar(255),
	"drawnAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "identityVerifiedAt" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sanctionsBlockedAt" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sanctionsScreenedAt" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "closedAt" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "webhookUrl" varchar(1024);--> statement-breakpoint
CREATE INDEX "alerts_open_index" ON "alerts" ("kind","nodePublicKey","acknowledgedAt");--> statement-breakpoint
CREATE INDEX "notifications_organizationId_index" ON "notifications" ("organizationId");--> statement-breakpoint
CREATE INDEX "notifications_nextAttemptAt_index" ON "notifications" ("nextAttemptAt");--> statement-breakpoint
CREATE INDEX "payment_flags_payee_status_index" ON "payment_flags" ("payeeOrganizationId","status");--> statement-breakpoint
CREATE INDEX "random_requests_contract_key_index" ON "random_requests" ("contractId","key");--> statement-breakpoint
CREATE INDEX "random_requests_rootRunId_index" ON "random_requests" ("rootRunId");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "payment_flags" ADD CONSTRAINT "payment_flags_payeeOrganizationId_organizations_id_fkey" FOREIGN KEY ("payeeOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "payment_flags" ADD CONSTRAINT "payment_flags_funderOrganizationId_organizations_id_fkey" FOREIGN KEY ("funderOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "payment_flags" ADD CONSTRAINT "payment_flags_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "random_requests" ADD CONSTRAINT "random_requests_contractId_contract_versions_id_fkey" FOREIGN KEY ("contractId") REFERENCES "contract_versions"("id");--> statement-breakpoint
ALTER TABLE "random_requests" ADD CONSTRAINT "random_requests_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");