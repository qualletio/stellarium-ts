CREATE TABLE "paused_users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "paused_users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" text NOT NULL,
	"organizationId" varchar(64) NOT NULL,
	"pausedAt" timestamp DEFAULT now() NOT NULL,
	"liftedAt" timestamp
);
--> statement-breakpoint
CREATE INDEX "paused_users_userId_index" ON "paused_users" ("userId");--> statement-breakpoint
ALTER TABLE "paused_users" ADD CONSTRAINT "paused_users_userId_auth_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "paused_users" ADD CONSTRAINT "paused_users_organizationId_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id");