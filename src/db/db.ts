import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const db = await open({
  filename: './requestscript.db', // Specify the database file
  driver: sqlite3.Database,
});

// Create tables

export async function createTables() {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS peer (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_url TEXT NOT NULL,
            public_key TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            UNIQUE (public_key),
            UNIQUE (base_url),
            UNIQUE (name)
        );

        CREATE TABLE IF NOT EXISTS resource (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (peer_id) REFERENCES peer(id),

            UNIQUE (path, name),
            UNIQUE (base_url)
        );

        CREATE TABLE IF NOT EXISTS resource_function (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            return_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL

            FOREIGN KEY (resource_id) REFERENCES resource(id),
        );

        CREATE TABLE IF NOT EXISTS resource_function_parameter (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_function_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            parameter_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL

            FOREIGN KEY (resource_function_id) REFERENCES resource_function(id),
        );
    `);
}


export default db;
