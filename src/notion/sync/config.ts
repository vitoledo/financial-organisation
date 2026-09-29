import path from 'path';
import { execSync } from 'child_process';
import { resolvePlannerConfig } from '../migration-runner/backfill-planner';
import { SyncDataSources } from './notion-gateway';
import { NotionSyncSettings } from './engine';

export interface NotionSyncConfig {
  notionApiKey: string;
  ds: SyncDataSources;
  settings: NotionSyncSettings;
  dataDir: string;
  dbPath: string;
  pierreApiKey: string | null;
  pierreApiUrl: string | undefined;
}

const REQUIRED = [
  'NOTION_API_KEY',
  'NOTION_DS_TRANSACTIONS',
  'NOTION_DS_CARD_BILLS',
  'NOTION_DS_ACCOUNTS',
  'NOTION_DS_CATEGORIES',
  'NOTION_DS_RULES',
  'NOTION_DS_SYNC_LOG',
];

function workerVersion(env: Record<string, string | undefined>): string {
  if (env.GIT_COMMIT?.trim()) return env.GIT_COMMIT.trim();
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Reads the sync configuration from the environment (fail closed on anything missing). The account mapping file
 * and the counterparty HMAC key are the same the backfill used, so incremental pages match the migrated ones.
 */
export function loadNotionSyncConfig(env: Record<string, string | undefined> = process.env): NotionSyncConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`FAIL_CLOSED_ENV: variáveis ausentes para a sincronização com o Notion: ${missing.join(', ')}.`);
  }
  const dataDir = path.resolve(process.cwd(), env.DATA_DIR ?? 'data');
  const mappingPath = env.ACCOUNT_MAPPING_PATH?.trim() || env.BACKFILL_ACCOUNT_MAPPING_PATH?.trim() || path.join(dataDir, 'account-mapping.json');
  const { effectiveConfig } = resolvePlannerConfig(undefined, { ...env, BACKFILL_ACCOUNT_MAPPING_PATH: mappingPath });

  const maxCreates = Number(env.NOTION_SYNC_MAX_CREATES ?? 300);
  return {
    notionApiKey: env.NOTION_API_KEY!.trim(),
    ds: {
      transactions: env.NOTION_DS_TRANSACTIONS!.trim(),
      bills: env.NOTION_DS_CARD_BILLS!.trim(),
      accounts: env.NOTION_DS_ACCOUNTS!.trim(),
      categories: env.NOTION_DS_CATEGORIES!.trim(),
      rules: env.NOTION_DS_RULES!.trim(),
      syncLog: env.NOTION_DS_SYNC_LOG!.trim(),
    },
    settings: {
      accountRoles: effectiveConfig.sourceAccountMapping,
      defaultDueDay: effectiveConfig.defaultDueDay,
      checkingAccountName: env.NOTION_CHECKING_ACCOUNT_NAME?.trim() || 'Nubank Conta',
      creditAccountName: env.NOTION_CREDIT_ACCOUNT_NAME?.trim() || 'Nubank Cartão',
      hmacKey: effectiveConfig.counterpartyHmacKey,
      hmacKeyVersion: effectiveConfig.hmacKeyVersion || 'v1',
      sameOwnershipKeywords: effectiveConfig.sameOwnershipCategoryKeywords || ['mesma titularidade'],
      maxCreates: Number.isFinite(maxCreates) && maxCreates > 0 ? maxCreates : 300,
      workerVersion: workerVersion(env),
    },
    dataDir,
    dbPath: env.DB_PATH?.trim() || path.join(dataDir, 'financial.db'),
    pierreApiKey: env.PIERRE_API_KEY?.trim() || null,
    pierreApiUrl: env.PIERRE_API_URL?.trim() || undefined,
  };
}
