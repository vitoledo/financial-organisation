import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runMigrations } from './migrations';

let db: Database.Database | null = null;

/**
 * Initialize (or return existing) SQLite database connection.
 * Creates the data directory and database file if they don't exist.
 */
export function getDatabase(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath ?? path.resolve(process.cwd(), 'data', 'financial.db');
  const dir = path.dirname(resolvedPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // WAL writes -wal/-shm siblings, so a stray reader can briefly lock the db.
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);

  return db;
}

/**
 * Close the database connection cleanly.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
