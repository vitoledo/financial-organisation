import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { parseKey32Bytes } from './backup';

const MAGIC_HEADER = Buffer.from('FIN_ENC_V1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface NotionPageRecord {
  id: string;
  createdTime: string;
  lastEditedTime: string;
  archived: boolean;
  url: string;
  properties: Record<string, any>;
}

export interface BaseSnapshotData {
  envKey: string;
  defaultTitle: string;
  dataSourceId: string;
  recordCount: number;
  records: NotionPageRecord[];
}

export interface LiveDataSnapshotMetadata {
  snapshotType: 'NOTION_LIVE_DATA_SNAPSHOT';
  timestampIso: string;
  notionApiVersion: string;
  totalBases: number;
  totalRecordsAllBases: number;
  summaryByDataSource: Record<
    string,
    {
      title: string;
      dataSourceId: string;
      recordCount: number;
    }
  >;
  reconciliationTotals: {
    accountsCount: number;
    transactionsCount: number;
    categoriesCount: number;
    rulesCount: number;
    fixedBillsCount: number;
    monthlyObligationsCount: number;
    investmentsCount: number;
    investmentMovementsCount: number;
    monthlyBudgetCount: number;
    financialGoalsCount: number;
    monthlyClosingsCount: number;
    syncLogCount: number;
    cardBillsCount: number;
    totalRecords: number;
  };
}

export interface LiveDataSnapshotPayload extends LiveDataSnapshotMetadata {
  bases: Record<string, BaseSnapshotData>;
}

export interface LiveDataSnapshotResult {
  backupPath: string;
  manifestPath: string;
  encryptedHashSha256: string;
  originalJsonSha256: string;
  originalSizeBytes: number;
  encryptedSizeBytes: number;
  timestamp: string;
  verifiedRestoration: boolean;
  metadata: LiveDataSnapshotMetadata;
}

export interface NotionLiveDataSnapshotOptions {
  client?: Client;
  apiKey?: string;
  envVars?: Record<string, string | undefined>;
  backupKey?: string;
  backupDir?: string;
}

export function sanitizeNotionProperty(prop: any): any {
  if (!prop || typeof prop !== 'object') return prop;
  const type = prop.type;
  if (!type) return prop;

  switch (type) {
    case 'title':
      return (prop.title || []).map((t: any) => t.plain_text || t.text?.content || '').join('');
    case 'rich_text':
      return (prop.rich_text || []).map((t: any) => t.plain_text || t.text?.content || '').join('');
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name ?? null;
    case 'multi_select':
      return (prop.multi_select || []).map((s: any) => s.name);
    case 'date':
      return prop.date ? { start: prop.date.start, end: prop.date.end } : null;
    case 'checkbox':
      return prop.checkbox;
    case 'relation':
      return (prop.relation || []).map((r: any) => r.id);
    case 'status':
      return prop.status?.name ?? null;
    case 'formula':
      return prop.formula;
    case 'rollup':
      return prop.rollup;
    default:
      return prop[type] ?? prop;
  }
}

export class NotionLiveDataSnapshotManager {
  private client: Client;
  private envVars: Record<string, string | undefined>;
  private backupKey?: string;
  private backupDir: string;
  private notionVersion = '2026-03-11';

  constructor(options: NotionLiveDataSnapshotOptions = {}) {
    this.envVars = options.envVars ?? (process.env as Record<string, string | undefined>);
    const apiKey = options.apiKey ?? this.envVars.NOTION_API_KEY?.trim();
    if (!apiKey && !options.client) {
      throw new Error('NOTION_API_KEY obrigatória para captura do snapshot de dados live.');
    }
    this.client =
      options.client ??
      new Client({
        auth: apiKey,
        notionVersion: this.notionVersion,
      });
    this.backupKey = options.backupKey ?? this.envVars.MIGRATION_BACKUP_KEY?.trim();
    this.backupDir = options.backupDir ?? path.resolve(process.cwd(), 'backups');
  }

  private deriveKey(key?: string): Buffer {
    const rawKey = key ?? this.backupKey ?? this.envVars.MIGRATION_BACKUP_KEY?.trim();
    return parseKey32Bytes(rawKey, 'MIGRATION_BACKUP_KEY');
  }


  private sanitizeProperty(prop: any): any {
    return sanitizeNotionProperty(prop);
  }

  public async fetchBaseRecords(envKey: string, dataSourceId: string): Promise<NotionPageRecord[]> {
    const records: NotionPageRecord[] = [];
    let hasMore = true;
    let startCursor: string | undefined = undefined;

    while (hasMore) {
      const response = (await this.client.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        start_cursor: startCursor,
      })) as {
        results: any[];
        has_more: boolean;
        next_cursor?: string | null;
      };

      for (const page of response.results || []) {
        const sanitizedProperties: Record<string, any> = {};
        for (const [propName, propVal] of Object.entries(page.properties || {})) {
          sanitizedProperties[propName] = this.sanitizeProperty(propVal);
        }

        records.push({
          id: page.id,
          createdTime: page.created_time,
          lastEditedTime: page.last_edited_time,
          archived: page.is_archived || page.in_trash || false,
          url: page.url,
          properties: sanitizedProperties,
        });
      }

      hasMore = !!response.has_more;
      startCursor = response.next_cursor ?? undefined;
    }

    return records;
  }

  public async captureLiveSnapshot(): Promise<LiveDataSnapshotResult> {
    const timestampIso = new Date().toISOString();
    const keyBuffer = this.deriveKey();

    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    const basesData: Record<string, BaseSnapshotData> = {};
    const summaryByDataSource: Record<string, { title: string; dataSourceId: string; recordCount: number }> = {};
    let totalRecordsAllBases = 0;

    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      const dsId = this.envVars[contract.envKey]?.trim();
      if (!dsId) {
        throw new Error(
          `CONFIG_ERROR: Variável ${contract.envKey} (${contract.defaultTitle}) não configurada no ambiente. Todas as 13 bases são obrigatórias para o snapshot de dados.`,
        );
      }

      const records = await this.fetchBaseRecords(contract.envKey, dsId);
      basesData[contract.envKey] = {
        envKey: contract.envKey,
        defaultTitle: contract.defaultTitle,
        dataSourceId: dsId,
        recordCount: records.length,
        records,
      };

      summaryByDataSource[contract.envKey] = {
        title: contract.defaultTitle,
        dataSourceId: dsId,
        recordCount: records.length,
      };

      totalRecordsAllBases += records.length;
    }

    const reconciliationTotals = {
      accountsCount: basesData['NOTION_DS_ACCOUNTS']?.recordCount ?? 0,
      transactionsCount: basesData['NOTION_DS_TRANSACTIONS']?.recordCount ?? 0,
      categoriesCount: basesData['NOTION_DS_CATEGORIES']?.recordCount ?? 0,
      rulesCount: basesData['NOTION_DS_RULES']?.recordCount ?? 0,
      fixedBillsCount: basesData['NOTION_DS_FIXED_BILLS']?.recordCount ?? 0,
      monthlyObligationsCount: basesData['NOTION_DS_MONTHLY_OBLIGATIONS']?.recordCount ?? 0,
      investmentsCount: basesData['NOTION_DS_INVESTMENTS']?.recordCount ?? 0,
      investmentMovementsCount: basesData['NOTION_DS_INVESTMENT_MOVEMENTS']?.recordCount ?? 0,
      monthlyBudgetCount: basesData['NOTION_DS_MONTHLY_BUDGET']?.recordCount ?? 0,
      financialGoalsCount: basesData['NOTION_DS_FINANCIAL_GOALS']?.recordCount ?? 0,
      monthlyClosingsCount: basesData['NOTION_DS_MONTHLY_CLOSINGS']?.recordCount ?? 0,
      syncLogCount: basesData['NOTION_DS_SYNC_LOG']?.recordCount ?? 0,
      cardBillsCount: basesData['NOTION_DS_CARD_BILLS']?.recordCount ?? 0,
      totalRecords: totalRecordsAllBases,
    };

    const payload: LiveDataSnapshotPayload = {
      snapshotType: 'NOTION_LIVE_DATA_SNAPSHOT',
      timestampIso,
      notionApiVersion: this.notionVersion,
      totalBases: Object.keys(TARGET_CONTRACT).length,
      totalRecordsAllBases,
      summaryByDataSource,
      reconciliationTotals,
      bases: basesData,
    };

    const jsonString = JSON.stringify(payload, null, 2);
    const plaintextBuffer = Buffer.from(jsonString, 'utf8');
    const originalSizeBytes = plaintextBuffer.length;
    const originalJsonSha256 = crypto.createHash('sha256').update(plaintextBuffer).digest('hex');

    // Encrypt with AES-256-GCM
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Payload: [MAGIC 10B][IV 12B][TAG 16B][CIPHERTEXT]
    const backupPayload = Buffer.concat([MAGIC_HEADER, iv, authTag, ciphertext]);
    const encryptedSizeBytes = backupPayload.length;

    const timestampClean = timestampIso.replace(/[-:]/g, '').replace(/\..+/, '');
    const uniqueSuffix = crypto.randomBytes(4).toString('hex');
    const backupFileName = `notion-data-snapshot-${timestampClean}-${uniqueSuffix}.json.enc`;
    const backupFilePath = path.join(this.backupDir, backupFileName);

    fs.writeFileSync(backupFilePath, backupPayload);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(backupFilePath, 0o600);
      } catch {
        /* non-POSIX */
      }
    }

    const encryptedHashSha256 = crypto.createHash('sha256').update(backupPayload).digest('hex');

    // Determine commitSha
    let commitSha = 'UNKNOWN';
    try {
      const { execSync } = require('child_process');
      commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      // fallback
    }

    // Determine 13 data source IDs and schema hashes
    const dataSourceIds: Record<string, string> = {};
    const schemaHashByBase: Record<string, string> = {};
    const rowCountByBase: Record<string, number> = {};

    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      const dsId = this.envVars[contract.envKey]?.trim() || '';
      dataSourceIds[contract.envKey] = dsId;
      schemaHashByBase[contract.envKey] = crypto
        .createHash('sha256')
        .update(JSON.stringify(contract.properties))
        .digest('hex');
      rowCountByBase[contract.envKey] = basesData[contract.envKey]?.recordCount ?? 0;
    }

    // Find corresponding sqlite backup
    let sqliteSourceBackupRef = '';
    try {
      const files = fs.readdirSync(this.backupDir);
      const dbBackups = files
        .filter((f) => f.startsWith('financial-backup-') && f.endsWith('.db.enc'))
        .sort()
        .reverse();
      if (dbBackups.length > 0) {
        sqliteSourceBackupRef = dbBackups[0];
      }
    } catch {
      // ignore
    }

    // Test restoration
    const verifiedRestoration = this.testRestoration(backupPayload, keyBuffer, originalJsonSha256);

    // Write sidecar manifest
    const manifestPath = `${backupFilePath}.manifest.json`;
    const manifestContent = {
      format: 'FIN_ENC_V1',
      algorithm: 'aes-256-gcm',
      envelopeVersion: 'FIN_ENC_V1',
      toolVersion: '1.0.0',
      capturedAt: timestampIso,
      timestamp: timestampIso,
      commitSha,
      backupFileName,
      encryptedFileSha256: encryptedHashSha256,
      originalJsonSha256,
      originalSizeBytes,
      encryptedSizeBytes,
      verifiedRestoration,
      scope: 'NOTION_ALL_13_CANONICAL_DATABASES',
      totalBases: 13,
      totalRecordsAllBases,
      dataSourceIds,
      schemaHashByBase,
      rowCountByBase,
      sqliteSourceBackupRef,
      summaryByDataSource,
      reconciliationTotals,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');

    return {
      backupPath: backupFilePath,
      manifestPath,
      encryptedHashSha256,
      originalJsonSha256,
      originalSizeBytes,
      encryptedSizeBytes,
      timestamp: timestampIso,
      verifiedRestoration,
      metadata: {
        snapshotType: 'NOTION_LIVE_DATA_SNAPSHOT',
        timestampIso,
        notionApiVersion: this.notionVersion,
        totalBases: 13,
        totalRecordsAllBases,
        summaryByDataSource,
        reconciliationTotals,
      },
    };
  }

  public decryptSnapshot(backupFilePath: string, key?: string): LiveDataSnapshotPayload {
    const keyBuffer = this.deriveKey(key);
    const encryptedBuffer = fs.readFileSync(backupFilePath);

    if (encryptedBuffer.length < MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH) {
      throw new Error('Arquivo de backup inválido: tamanho menor que o cabeçalho mínimo.');
    }

    const magic = encryptedBuffer.subarray(0, MAGIC_HEADER.length);
    if (!magic.equals(MAGIC_HEADER)) {
      throw new Error('Cabeçalho mágico inválido: esperado FIN_ENC_V1.');
    }

    const iv = encryptedBuffer.subarray(MAGIC_HEADER.length, MAGIC_HEADER.length + IV_LENGTH);
    const authTag = encryptedBuffer.subarray(
      MAGIC_HEADER.length + IV_LENGTH,
      MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH,
    );
    const ciphertext = encryptedBuffer.subarray(MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return JSON.parse(decrypted.toString('utf8')) as LiveDataSnapshotPayload;
  }

  public restoreAndValidateToTempDir(
    backupFilePath: string,
    tempTargetDir: string,
    key?: string,
  ): {
    valid: boolean;
    restoredJsonPath: string;
    totalRecordsValidated: number;
    basesSummary: Record<string, { recordCount: number; sampleIds: string[] }>;
  } {
    if (!fs.existsSync(tempTargetDir)) {
      fs.mkdirSync(tempTargetDir, { recursive: true });
    }

    const payload = this.decryptSnapshot(backupFilePath, key);
    const restoredJsonPath = path.join(tempTargetDir, 'notion-data-snapshot-restored.json');
    fs.writeFileSync(restoredJsonPath, JSON.stringify(payload, null, 2), 'utf8');

    // Read back and validate from disk
    const readBack = JSON.parse(fs.readFileSync(restoredJsonPath, 'utf8')) as LiveDataSnapshotPayload;
    if (readBack.snapshotType !== 'NOTION_LIVE_DATA_SNAPSHOT' || readBack.totalBases !== 13) {
      throw new Error('Validação de restauração falhou: estrutura de bases inconsistente.');
    }

    const basesSummary: Record<string, { recordCount: number; sampleIds: string[] }> = {};
    let totalRecordsValidated = 0;

    for (const [key, base] of Object.entries(readBack.bases)) {
      basesSummary[key] = {
        recordCount: base.recordCount,
        sampleIds: (base.records || []).slice(0, 3).map((r) => r.id),
      };
      totalRecordsValidated += base.recordCount;
    }

    return {
      valid: totalRecordsValidated === readBack.totalRecordsAllBases,
      restoredJsonPath,
      totalRecordsValidated,
      basesSummary,
    };
  }

  private testRestoration(
    encryptedBuffer: Buffer,
    keyBuffer: Buffer,
    expectedSha256: string,
  ): boolean {
    if (encryptedBuffer.length < MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH) {
      return false;
    }

    const magic = encryptedBuffer.subarray(0, MAGIC_HEADER.length);
    if (!magic.equals(MAGIC_HEADER)) {
      return false;
    }

    const iv = encryptedBuffer.subarray(MAGIC_HEADER.length, MAGIC_HEADER.length + IV_LENGTH);
    const authTag = encryptedBuffer.subarray(
      MAGIC_HEADER.length + IV_LENGTH,
      MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH,
    );
    const ciphertext = encryptedBuffer.subarray(MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const actualSha256 = crypto.createHash('sha256').update(decrypted).digest('hex');
    if (actualSha256 !== expectedSha256) {
      return false;
    }

    const parsed = JSON.parse(decrypted.toString('utf8'));
    return parsed.snapshotType === 'NOTION_LIVE_DATA_SNAPSHOT' && parsed.totalBases === 13;
  }
}

/**
 * Deterministically canonicalizes arbitrary values (objects sorted by keys, string arrays sorted).
 * Excludes non-semantic metadata.
 */
export function canonicalizeValue(val: any): any {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) {
    const mapped = val.map(canonicalizeValue);
    if (mapped.every((item) => typeof item === 'string')) {
      return [...mapped].sort();
    }
    return mapped;
  }
  if (typeof val === 'object') {
    const sortedObj: Record<string, any> = {};
    for (const k of Object.keys(val).sort()) {
      sortedObj[k] = canonicalizeValue(val[k]);
    }
    return sortedObj;
  }
  return val;
}

/**
 * Computes canonical deterministic SHA-256 target state hash across all bases.
 * Canonical deterministic sorting: envKey -> pageId -> property name -> relation IDs.
 * Non-semantic capture metadata (timestamps, urls) is strictly excluded.
 */
export function calculateTargetStateHash(bases: Record<string, BaseSnapshotData>): string {
  const sortedEnvKeys = Object.keys(bases).sort();
  const canonicalBases: any[] = [];

  for (const envKey of sortedEnvKeys) {
    const base = bases[envKey];
    const records = [...(base?.records || [])].sort((a, b) => {
      const idA = (a.id || (a as any).pageId || '').toString();
      const idB = (b.id || (b as any).pageId || '').toString();
      return idA.localeCompare(idB);
    });

    const canonicalRecords = records.map((rec) => {
      const sortedProps: Record<string, any> = {};
      for (const propKey of Object.keys(rec.properties || {}).sort()) {
        sortedProps[propKey] = canonicalizeValue(rec.properties[propKey]);
      }
      return {
        pageId: (rec.id || (rec as any).pageId || '').toString(),
        archived: Boolean(rec.archived),
        properties: sortedProps,
      };
    });

    canonicalBases.push({
      envKey,
      dataSourceId: base?.dataSourceId || '',
      records: canonicalRecords,
    });
  }

  const preimage = JSON.stringify(canonicalBases);
  return crypto.createHash('sha256').update(preimage).digest('hex');
}

/**
 * Extracts Notion accounts format required by BackfillPlanner directly from snapshot records.
 */
export function extractNotionAccountsFromSnapshot(records: NotionPageRecord[]): any[] {
  return (records || []).map((p) => {
    let name = '';
    if (typeof p.properties['Conta'] === 'string') {
      name = p.properties['Conta'].trim();
    } else if (typeof p.properties['Nome da Conta'] === 'string') {
      name = p.properties['Nome da Conta'].trim();
    } else if (Array.isArray(p.properties['Conta']?.title)) {
      name = p.properties['Conta'].title.map((t: any) => t.plain_text || '').join('').trim();
    } else if (Array.isArray(p.properties['Nome da Conta']?.title)) {
      name = p.properties['Nome da Conta'].title.map((t: any) => t.plain_text || '').join('').trim();
    }
    const type = typeof p.properties['Tipo'] === 'object' && p.properties['Tipo']?.select?.name
      ? p.properties['Tipo'].select.name
      : p.properties['Tipo'];
    const creditLimit = typeof p.properties['Limite contratado'] === 'object'
      ? p.properties['Limite contratado']?.number
      : p.properties['Limite contratado'];
    const customLimit = typeof p.properties['Limite personalizado'] === 'object'
      ? p.properties['Limite personalizado']?.number
      : p.properties['Limite personalizado'];
    const availableLimit = typeof p.properties['Limite disponível'] === 'object'
      ? p.properties['Limite disponível']?.number
      : p.properties['Limite disponível'];

    return {
      id: p.id,
      name,
      type,
      creditLimit,
      customLimit,
      availableLimit,
    };
  });
}

/**
 * Extracts Notion categories format required by BackfillPlanner directly from snapshot records.
 */
export function extractNotionCategoriesFromSnapshot(records: NotionPageRecord[]): any[] {
  return (records || []).map((p) => {
    let name = '';
    if (typeof p.properties['Categoria'] === 'string') {
      name = p.properties['Categoria'].trim();
    } else if (typeof p.properties['Nome da Categoria'] === 'string') {
      name = p.properties['Nome da Categoria'].trim();
    } else if (Array.isArray(p.properties['Categoria']?.title)) {
      name = p.properties['Categoria'].title.map((t: any) => t.plain_text || '').join('').trim();
    } else if (Array.isArray(p.properties['Nome da Categoria']?.title)) {
      name = p.properties['Nome da Categoria'].title.map((t: any) => t.plain_text || '').join('').trim();
    }
    const group = typeof p.properties['Grupo'] === 'object' && p.properties['Grupo']?.select?.name
      ? p.properties['Grupo'].select.name
      : p.properties['Grupo'];

    return {
      id: p.id,
      name,
      group,
    };
  });
}
