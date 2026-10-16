ALTER TABLE "receipts" ADD COLUMN "invocationHash" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "resourcePath";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "resourceName";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "parameters";