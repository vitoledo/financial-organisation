import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface AppConfig {
  // Pierre
  pierreApiKey: string;

  // Google OAuth2
  googleClientId: string;
  googleClientSecret: string;

  // Paths
  dbPath: string;
  logPath: string;
  tokensPath: string;
  spreadsheetIdPath: string;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.cwd(), 'data');

  const config: AppConfig = {
    pierreApiKey: requireEnv('PIERRE_API_KEY'),
    googleClientId: requireEnv('GOOGLE_CLIENT_ID'),
    googleClientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    dbPath: process.env.DB_PATH ?? path.join(dataDir, 'financial.db'),
    logPath: process.env.LOG_PATH ?? path.join(dataDir, 'sync.log'),
    tokensPath: process.env.TOKENS_PATH ?? path.join(dataDir, 'google-tokens.json'),
    spreadsheetIdPath: process.env.SPREADSHEET_ID
      ? '' // Will be handled separately if pre-set
      : path.join(dataDir, 'spreadsheet-id.txt'),
  };

  // If SPREADSHEET_ID is provided, write it to the expected path
  if (process.env.SPREADSHEET_ID) {
    const fs = require('fs');
    const dir = path.dirname(config.spreadsheetIdPath || path.join(dataDir, 'spreadsheet-id.txt'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    config.spreadsheetIdPath = path.join(dataDir, 'spreadsheet-id.txt');
    if (process.env.SPREADSHEET_ID.trim()) {
      fs.writeFileSync(config.spreadsheetIdPath, process.env.SPREADSHEET_ID.trim());
    }
  }

  return config;
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
