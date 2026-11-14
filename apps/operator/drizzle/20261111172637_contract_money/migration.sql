CREATE TABLE "contract_funding" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contract_funding_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contractId" integer NOT NULL,
	"funderOrganizationId" varchar(64) NOT NULL,
	"key" varchar(255),
	"payees" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"rootRunId" integer,
	"attachmentId" uuid,
	"amountMicroUsd" bigint NOT NULL,
	"lockedMicroUsd" bigint DEFAULT 0 NOT NULL,
	"sourceFundingId" integer,
	"fundedAt" timestamp NOT NULL,
	"chargedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_money_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contract_money_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contractId" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"amountMicroUsd" bigint NOT NULL,
	"funderOrganizationId" varchar(64) NOT NULL,
	"counterpartyOrganizationId" varchar(64),
	"counterpartyContractId" integer,
	"runId" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contract_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"nodePublicKey" varchar(255) NOT NULL,
	"name" varchar(512) NOT NULL,
	"version" varchar(64) NOT NULL,
	"payable" boolean NOT NULL,
	"source" text NOT NULL,
	"sourceHash" varchar(64) NOT NULL,
	"ownerOrganizationId" varchar(64) NOT NULL,
	"requestscriptVersion" varchar(64) NOT NULL,
	"dependencies" jsonb NOT NULL,
	"balanceMicroUsd" bigint DEFAULT 0 NOT NULL,
	"refundAllAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contract_versions_node_name_version_unique" UNIQUE("nodePublicKey","name","version")
);
--> statement-breakpoint
CREATE TABLE "money_changes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "money_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"runId" integer NOT NULL,
	"rootRunId" integer NOT NULL,
	"callIndex" integer NOT NULL,
	"function" varchar(16) NOT NULL,
	"parameters" jsonb NOT NULL,
	"result" jsonb,
	"status" varchar(16) DEFAULT 'staged' NOT NULL,
	"contractId" integer,
	"payerOrganizationId" varchar(64),
	"recipientOrganizationId" varchar(64),
	"amountMicroUsd" bigint DEFAULT 0 NOT NULL,
	"allocations" jsonb DEFAULT '[]' NOT NULL,
	"fundingIds" jsonb DEFAULT '[]' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"settledAt" timestamp,
	CONSTRAINT "money_changes_runId_callIndex_unique" UNIQUE("runId","callIndex")
);
--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "maxRunValueMicroUsd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "contractId" integer;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "maxApiKeyRunValueMicroUsd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "monthlyApiKeyValueCapMicroUsd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "maxContractBalanceMicroUsd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "rootRunId" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "outcome" varchar(16);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "treeOutcome" varchar(16);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "treeDeadlineAt" timestamp;--> statement-breakpoint
CREATE INDEX "contract_funding_contractId_funder_key_index" ON "contract_funding" ("contractId","funderOrganizationId","key");--> statement-breakpoint
CREATE INDEX "contract_funding_status_fundedAt_index" ON "contract_funding" ("status","fundedAt");--> statement-breakpoint
CREATE INDEX "contract_funding_rootRunId_index" ON "contract_funding" ("rootRunId");--> statement-breakpoint
CREATE INDEX "contract_funding_attachmentId_index" ON "contract_funding" ("attachmentId");--> statement-breakpoint
CREATE INDEX "contract_money_log_contractId_index" ON "contract_money_log" ("contractId");--> statement-breakpoint
CREATE INDEX "contract_versions_ownerOrganizationId_index" ON "contract_versions" ("ownerOrganizationId");--> statement-breakpoint
CREATE INDEX "money_changes_rootRunId_index" ON "money_changes" ("rootRunId");--> statement-breakpoint
CREATE INDEX "runs_rootRunId_index" ON "runs" ("rootRunId");--> statement-breakpoint
CREATE INDEX "runs_treeOutcome_index" ON "runs" ("treeOutcome");--> statement-breakpoint
ALTER TABLE "contract_funding" ADD CONSTRAINT "contract_funding_contractId_contract_versions_id_fkey" FOREIGN KEY ("contractId") REFERENCES "contract_versions"("id");--> statement-breakpoint
ALTER TABLE "contract_funding" ADD CONSTRAINT "contract_funding_funderOrganizationId_organizations_id_fkey" FOREIGN KEY ("funderOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "contract_funding" ADD CONSTRAINT "contract_funding_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "contract_funding" ADD CONSTRAINT "contract_funding_sourceFundingId_contract_funding_id_fkey" FOREIGN KEY ("sourceFundingId") REFERENCES "contract_funding"("id");--> statement-breakpoint
ALTER TABLE "contract_money_log" ADD CONSTRAINT "contract_money_log_contractId_contract_versions_id_fkey" FOREIGN KEY ("contractId") REFERENCES "contract_versions"("id");--> statement-breakpoint
ALTER TABLE "contract_money_log" ADD CONSTRAINT "contract_money_log_runId_runs_id_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_nodePublicKey_nodes_publicKey_fkey" FOREIGN KEY ("nodePublicKey") REFERENCES "nodes"("publicKey");--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_ownerOrganizationId_organizations_id_fkey" FOREIGN KEY ("ownerOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_contractId_contract_versions_id_fkey" FOREIGN KEY ("contractId") REFERENCES "contract_versions"("id");--> statement-breakpoint
ALTER TABLE "money_changes" ADD CONSTRAINT "money_changes_runId_runs_id_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "money_changes" ADD CONSTRAINT "money_changes_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "money_changes" ADD CONSTRAINT "money_changes_contractId_contract_versions_id_fkey" FOREIGN KEY ("contractId") REFERENCES "contract_versions"("id");--> statement-breakpoint
ALTER TABLE "money_changes" ADD CONSTRAINT "money_changes_payerOrganizationId_organizations_id_fkey" FOREIGN KEY ("payerOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "money_changes" ADD CONSTRAINT "money_changes_recipientOrganizationId_organizations_id_fkey" FOREIGN KEY ("recipientOrganizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_rootRunId_runs_id_fkey" FOREIGN KEY ("rootRunId") REFERENCES "runs"("id");