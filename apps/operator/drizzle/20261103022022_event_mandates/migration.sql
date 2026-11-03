CREATE TABLE "event_mandates" (
	"id" varchar(64) PRIMARY KEY,
	"organizationId" varchar(64) NOT NULL,
	"clientId" varchar(64) NOT NULL,
	"nodePublicKey" varchar(255) NOT NULL,
	"consumer" varchar(512) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	CONSTRAINT "event_mandates_clientId_consumer_unique" UNIQUE("clientId","consumer")
);
--> statement-breakpoint
CREATE INDEX "event_mandates_organizationId_index" ON "event_mandates" ("organizationId");--> statement-breakpoint
ALTER TABLE "event_mandates" ADD CONSTRAINT "event_mandates_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "event_mandates" ADD CONSTRAINT "event_mandates_clientId_api_clients_id_fkey" FOREIGN KEY ("clientId") REFERENCES "api_clients"("id");--> statement-breakpoint
ALTER TABLE "event_mandates" ADD CONSTRAINT "event_mandates_nodePublicKey_nodes_publicKey_fkey" FOREIGN KEY ("nodePublicKey") REFERENCES "nodes"("publicKey");