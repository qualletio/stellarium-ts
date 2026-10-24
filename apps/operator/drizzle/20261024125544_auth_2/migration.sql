CREATE TABLE "api_clients" (
	"id" varchar(64) PRIMARY KEY,
	"secretHash" varchar(64) NOT NULL,
	"organizationId" varchar(64) NOT NULL,
	"nodePublicKey" varchar(255) NOT NULL,
	"label" varchar(255),
	"maxRunCostMicroUsd" bigint NOT NULL,
	"monthlyCapMicroUsd" bigint,
	"createdBy" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"runId" uuid NOT NULL UNIQUE,
	"clientId" varchar(64) NOT NULL,
	"payerOrganizationId" varchar(64) NOT NULL,
	"recipientOrganizationId" varchar(64) NOT NULL,
	"nodePublicKey" varchar(255) NOT NULL,
	"status" varchar(16) DEFAULT 'held' NOT NULL,
	"priceMicroUsdPerMillionTokens" bigint NOT NULL,
	"maxTokens" bigint NOT NULL,
	"holdMicroUsd" bigint NOT NULL,
	"heldMicroUsd" bigint NOT NULL,
	"tokenBudgetMicroUsd" bigint NOT NULL,
	"tokens" bigint,
	"amountMicroUsd" bigint,
	"feeMicroUsd" bigint,
	"expiresAt" timestamp NOT NULL,
	"capturedAt" timestamp,
	"releasedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "runId" integer;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "baseUrl" varchar(1024);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "name" varchar(255);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "description" varchar(2048);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "priceMicroUsdPerMillionTokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "listed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "verifiedAt" timestamp;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "runId" integer;--> statement-breakpoint
CREATE INDEX "api_clients_organizationId_index" ON "api_clients" ("organizationId");--> statement-breakpoint
CREATE INDEX "receipts_runId_index" ON "receipts" ("runId");--> statement-breakpoint
CREATE INDEX "runs_clientId_createdAt_index" ON "runs" ("clientId","createdAt");--> statement-breakpoint
CREATE INDEX "runs_payerOrganizationId_index" ON "runs" ("payerOrganizationId");--> statement-breakpoint
CREATE INDEX "runs_recipientOrganizationId_index" ON "runs" ("recipientOrganizationId");--> statement-breakpoint
CREATE INDEX "runs_status_expiresAt_index" ON "runs" ("status","expiresAt");--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_nodePublicKey_nodes_publicKey_fkey" FOREIGN KEY ("nodePublicKey") REFERENCES "nodes"("publicKey");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_runId_runs_id_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_runId_runs_id_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_clientId_api_clients_id_fkey" FOREIGN KEY ("clientId") REFERENCES "api_clients"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_payerOrganizationId_organizations_id_fkey" FOREIGN KEY ("payerOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_recipientOrganizationId_organizations_id_fkey" FOREIGN KEY ("recipientOrganizationId") REFERENCES "organizations"("id");