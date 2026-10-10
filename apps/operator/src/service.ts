import type { NodePgDatabase as Database } from 'drizzle-orm/node-postgres';

export interface Service {
    db: Database;
}

export function createService(db: Database): Service {
    return {
        db,
    };
}
