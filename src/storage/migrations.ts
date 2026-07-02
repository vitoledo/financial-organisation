import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

/**
 * Run all pending migrations. Uses a simple user_version pragma to track
 * which migrations have been applied.
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion < 1) {
    db.exec(MIGRATION_001);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

// ---------------------------------------------------------------------------
// Migration 001 — Initial schema
// ---------------------------------------------------------------------------

const MIGRATION_001 = `
  -- Accounts
  CREATE TABLE IF NOT EXISTS accounts (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    type              TEXT NOT NULL,
    subtype           TEXT NOT NULL,
    connector_name    TEXT,
    closing_balance   REAL,
    credit_limit      REAL,
    available_credit  REAL,
    last_synced_at    TEXT,
    raw_json          TEXT
  );

  -- Transactions
  CREATE TABLE IF NOT EXISTS transactions (
    id                    TEXT PRIMARY KEY,
    account_id            TEXT NOT NULL,
    date                  TEXT NOT NULL,
    description           TEXT NOT NULL,
    amount                REAL NOT NULL,
    original_amount       REAL NOT NULL,
    direction             TEXT NOT NULL,
    category_pierre       TEXT,
    category_mapped       TEXT,
    category_group        TEXT,
    category_variability  TEXT,
    account_name          TEXT,
    account_type          TEXT,
    status                TEXT,
    raw_json              TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  -- Installments
  CREATE TABLE IF NOT EXISTS installments (
    id                    TEXT PRIMARY KEY,
    purchase_description  TEXT,
    installment_number    INTEGER,
    total_installments    INTEGER,
    amount                REAL,
    due_date              TEXT,
    is_paid               INTEGER DEFAULT 0,
    is_projected          INTEGER DEFAULT 0,
    account_id            TEXT,
    account_name          TEXT,
    raw_json              TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  -- Sync log
  CREATE TABLE IF NOT EXISTS sync_log (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at            TEXT NOT NULL,
    completed_at          TEXT,
    status                TEXT NOT NULL,
    transactions_added    INTEGER DEFAULT 0,
    transactions_updated  INTEGER DEFAULT 0,
    error_message         TEXT
  );

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_transactions_account  ON transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_direction ON transactions(direction);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_mapped);
`;
