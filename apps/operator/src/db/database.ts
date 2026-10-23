import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Any async Postgres driver: node-postgres in production, PGlite in tests. */
export type Database = PgAsyncDatabase<PgQueryResultHKT>;

/** The handle a `Database.transaction` callback receives. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
