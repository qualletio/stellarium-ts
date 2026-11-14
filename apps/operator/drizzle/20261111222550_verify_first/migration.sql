ALTER TABLE "fraud_cases" ADD COLUMN "recoveredMicroUsd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fraud_cases" ADD COLUMN "shortfallMicroUsd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_receipts" ALTER COLUMN "receipt" SET DATA TYPE json USING "receipt"::json;