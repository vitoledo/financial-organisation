import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

export interface AppConfig {
  // Pierre
  pierreApiKey: string;
  pierreApiUrl?: string;

  // Google OAuth2
  googleClientId: string;
  googleClientSecret: string;

  // Paths
  dataDir: string;
  dbPath: string;
  logPath: string;
  tokensPath: string;
  spreadsheetIdPath: string;

  // Runtime behavior
  headless: boolean;      // Never open a browser (server/container context)
  logToFile: boolean;     // Write pino file transport (off in containers → stdout only)
  staleHours: number;     // Heartbeat staleness threshold for the healthcheck
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
  const spreadsheetIdPath = path.join(dataDir, 'spreadsheet-id.txt');

  // A pre-set SPREADSHEET_ID (e.g. to reuse an existing sheet) is materialized
  // to the same file the setup step reads, so the rest of the pipeline has a
  // single source of truth for the spreadsheet id.
  const presetSpreadsheetId = process.env.SPREADSHEET_ID?.trim();
  if (presetSpreadsheetId) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(spreadsheetIdPath, presetSpreadsheetId);
  }

  return {
    pierreApiKey: requireEnv('PIERRE_API_KEY'),
    pierreApiUrl: process.env.PIERRE_API_URL,
    googleClientId: requireEnv('GOOGLE_CLIENT_ID'),
    googleClientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    dataDir,
    dbPath: process.env.DB_PATH ?? path.join(dataDir, 'financial.db'),
    logPath: process.env.LOG_PATH ?? path.join(dataDir, 'sync.log'),
    tokensPath: process.env.TOKENS_PATH ?? path.join(dataDir, 'google-tokens.json'),
    spreadsheetIdPath,
    headless: process.env.HEADLESS === '1' || !process.stdout.isTTY,
    logToFile: process.env.LOG_TO_FILE !== '0',
    staleHours: Number(process.env.STALE_HOURS ?? 96),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Copy .env.example to .env and fill in your credentials.`,
    );
  }
  return value;
}
