ALTER TABLE "money_changes" ADD COLUMN "feeMicroUsd" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "verification" varchar(16);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "verifiedAt" timestamp;--> statement-breakpoint
CREATE INDEX "money_changes_recipient_function_index" ON "money_changes" ("recipientOrganizationId","function");--> statement-breakpoint
CREATE INDEX "runs_verification_index" ON "runs" ("verification");