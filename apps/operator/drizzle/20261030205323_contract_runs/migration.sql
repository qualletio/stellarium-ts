ALTER TABLE "runs" ADD COLUMN "kind" varchar(16) DEFAULT 'script' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parentRunId" integer;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "clientId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parentRunId_runs_id_fkey" FOREIGN KEY ("parentRunId") REFERENCES "runs"("id");