import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/storage/migrations';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('runs initial migrations on fresh database', () => {
    runMigrations(db);

    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(3);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('transactions');
    expect(tableNames).toContain('installments');
    expect(tableNames).toContain('investments');
  });

  it('migrates from version 1 schema to the current schema', () => {
    // Manually set up schema version 1
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY);
    `);
    db.pragma('user_version = 1');

    expect(db.pragma('user_version', { simple: true })).toBe(1);

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(3);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('investments');
  });

  it('adds the reserve columns when upgrading a v2 database', () => {
    // A v2 database already has the investments table but no reserve columns —
    // exactly the shape shipped before the caixinha placement check existed.
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, subtype TEXT,
        connector_name TEXT, closing_balance REAL, credit_limit REAL,
        available_credit REAL, last_synced_at TEXT, raw_json TEXT
      );
      CREATE TABLE investments (id TEXT PRIMARY KEY);
    `);
    db.pragma('user_version = 2');

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(3);

    const columns = (db.pragma('table_info(accounts)') as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('automatically_invested_balance');
    expect(columns).toContain('reserved_total');
  });

  it('is a no-op when the database is already current', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });
});
