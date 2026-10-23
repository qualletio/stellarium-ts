// Seeds a local development database: a provider and a caller organization, each with one enrolled node,
// so paid calls between the fixture nodes work without Stripe or the dashboard. Safe to run on every start.
//
//   SEED_PROVIDER_PUBLIC_KEY / SEED_CALLER_PUBLIC_KEY   the nodes' SIGNING_PUBLIC_KEY values
//   SEED_CALLER_CREDIT_MICRO_USD                        promotional credit for the caller, once (default $10)
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { OrganizationService } from './organizations.js';

export const SEED_PROVIDER_ORGANIZATION_ID = 'org_local_provider';
export const SEED_CALLER_ORGANIZATION_ID = 'org_local_caller';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const providerPublicKey = required('SEED_PROVIDER_PUBLIC_KEY');
const callerPublicKey = required('SEED_CALLER_PUBLIC_KEY');
const credit = Number(process.env.SEED_CALLER_CREDIT_MICRO_USD ?? 10_000_000);
if (!Number.isSafeInteger(credit) || credit < 0) throw new Error('SEED_CALLER_CREDIT_MICRO_USD must be a nonnegative integer');

const db = drizzle(required('DATABASE_URL'));
await migrate(db, { migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle') });
const organizations = new OrganizationService(db);

await organizations.create('Local provider', { id: SEED_PROVIDER_ORGANIZATION_ID });
// Stands in for a completed Connect onboarding.
await organizations.setPayoutsEnabled(SEED_PROVIDER_ORGANIZATION_ID, true);
await organizations.enroll(SEED_PROVIDER_ORGANIZATION_ID, providerPublicKey, 'local-resource-node');

// Credit is granted only when the organization is first created, so restarts don't add more.
if (await organizations.create('Local caller', { id: SEED_CALLER_ORGANIZATION_ID }) && credit > 0) {
  await organizations.grantPromotion(SEED_CALLER_ORGANIZATION_ID, credit);
}
await organizations.enroll(SEED_CALLER_ORGANIZATION_ID, callerPublicKey, 'local-caller-node');

console.log(`Seeded ${SEED_PROVIDER_ORGANIZATION_ID} and ${SEED_CALLER_ORGANIZATION_ID}`);
await db.$client.end();
