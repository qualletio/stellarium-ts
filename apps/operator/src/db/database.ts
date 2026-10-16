import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Any async Postgres driver: node-postgres in production, PGlite in tests. */
export type Database = PgAsyncDatabase<PgQueryResultHKT>;
