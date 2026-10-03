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
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            UNIQUE (base_url)
            UNIQUE (name)
        );

        CREATE TABLE IF NOT EXISTS resources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            UNIQUE (path, name)
            UNIQUE (base_url)
        );

        CREATE TABLE IF NOT EXISTS resource_functions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            return_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS resource_function_parameters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_function_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            parameter_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
}


export default db;
