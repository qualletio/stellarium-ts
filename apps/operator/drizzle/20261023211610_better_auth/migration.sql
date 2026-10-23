-- Dashboard sign-in moves from Clerk to Better Auth. Clerk organization ids have no Better Auth counterpart, so the links are dropped:
-- an organization created from the dashboard under Clerk must be relinked by hand (set "authOrganizationId").
CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_invitations" (
	"id" text PRIMARY KEY,
	"organizationId" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"inviterId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_members" (
	"id" text PRIMARY KEY,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_organizations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"metadata" text,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"userId" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"activeOrganizationId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_clerkOrgId_key";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "authOrganizationId" text;--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "clerkOrgId";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_authOrganizationId_key" UNIQUE("authOrganizationId");--> statement-breakpoint
CREATE INDEX "auth_accounts_userId_index" ON "auth_accounts" ("userId");--> statement-breakpoint
CREATE INDEX "auth_invitations_organizationId_index" ON "auth_invitations" ("organizationId");--> statement-breakpoint
CREATE INDEX "auth_invitations_email_index" ON "auth_invitations" ("email");--> statement-breakpoint
CREATE INDEX "auth_members_organizationId_index" ON "auth_members" ("organizationId");--> statement-breakpoint
CREATE INDEX "auth_members_userId_index" ON "auth_members" ("userId");--> statement-breakpoint
CREATE INDEX "auth_sessions_userId_index" ON "auth_sessions" ("userId");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_index" ON "auth_verifications" ("identifier");--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_userId_auth_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitations_organizationId_auth_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "auth_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_invitations" ADD CONSTRAINT "auth_invitations_inviterId_auth_users_id_fkey" FOREIGN KEY ("inviterId") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_members" ADD CONSTRAINT "auth_members_organizationId_auth_organizations_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "auth_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_members" ADD CONSTRAINT "auth_members_userId_auth_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_auth_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_authOrganizationId_auth_organizations_id_fkey" FOREIGN KEY ("authOrganizationId") REFERENCES "auth_organizations"("id");