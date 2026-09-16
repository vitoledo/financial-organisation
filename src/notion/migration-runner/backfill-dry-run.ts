import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Client } from '@notionhq/client';
import { BackfillPlanner, resolvePlannerConfig } from './backfill-planner';
import { NotionSchemaValidator } from '../schema-validator';
import {
  NotionLiveDataSnapshotManager,
  BaseSnapshotData,
  LiveDataSnapshotPayload,
  calculateTargetStateHash,
  extractNotionAccountsFromSnapshot,
  extractNotionCategoriesFromSnapshot,
  canonicalizeValue,
} from './data-snapshot';
import { FinancialBackupManager, parseKey32Bytes } from './backup';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import {
  BackfillPlanArtifact,
  TransactionResolutionAudit,
  CardBillAuditItem,
  CategoryReconciliationItem,
  ProposedDerivedUpdateAudit,
  PaymentLegAuditItem,
  IncomingTransferAuditItem,
  PaymentEventAllocation,
  BackfillSchemaConformanceEvidence,
  BackfillPlannerConfig,
  TargetDriftDifference,
  TargetDriftReport,
} from './types';

export interface BackfillBaseAnalysis {
  envKey: string;
  databaseTitle: string;
  currentNotionRows: number;
  rowsToCreate: number;
  rowsToUpdate: number;
  rowsUnchanged: number;
  relationsToPopulate: Record<string, number>;
  duplicatesDetected: number;
  ambiguousItems: Array<{ id: string; reason: string; item: any }>;
  financialTotals?: Record<string, number>;
}

export interface BackfillDryRunAnalyzerOptions {
  dbPath?: string;
  client?: Client;
  apiKey?: string;
  envVars?: Record<string, string | undefined>;
  targetSnapshotManifestPath?: string;
  sourceSnapshotManifestPath?: string;
  targetNotionSnapshotHash?: string;
  commitSha?: string;
  schemaEvidence?: BackfillSchemaConformanceEvidence;
  plannerConfig?: BackfillPlannerConfig;
  accountMappingPath?: string;
  liveBases?: Record<string, BaseSnapshotData>;
  skipLiveDriftCheck?: boolean;
  _deliberateErrorAfterRestore?: boolean;
}


export interface BackfillDryRunReport {
  timestampIso: string;
  sourceDatabase: string;
  totalSourceTransactions: number;
  totalSourceAccounts: number;
  basesAnalysis: Record<string, BackfillBaseAnalysis>;
  summary: {
    totalRowsToCreate: number;
    totalRowsToUpdate: number;
    totalRelationsToPopulate: number;
    totalDuplicates: number;
    totalAmbiguities: number;
  };
  reconciliation: {
    minDate: string;
    maxDate: string;
    countByMonth: Record<string, number>;
    byNature: Record<string, { count: number; sum: number }>;
    byBudgetEffect: Record<string, { count: number; sum: number }>;
    checkingCashFlow: {
      inflowsTotal: number;
      thirdPartyInflows: number;
      sameOwnershipInflows: number;
      directOutflows: number;
      outgoingInternalTransfers: number;
      cardBillSettlementOutflows: number;
      pendingOutflows?: number;
      totalOutflows: number;
      netCashFlow: number;
    };
    cardLiability: {
      totalPurchases: number;
      purchasesCount: number;
      paymentsCreditsRecorded: number;
      paymentsCreditsCount: number;
    };
    economicConsumption: {
      directCheckingExpenses: number;
      cardPurchases: number;
      totalEconomicExpenses: number;
      confirmedEconomicExpenses?: number;
      pendingEconomicOutflows?: number;
      physicalCashOutflows?: number;
      economicIncome: number;
      pendingThirdPartyInflows: number;
      neutralSettlements: number;
      neutralTransfers: number;
    };
    paymentAuditSummary: {
      totalPaymentOccurrences: number;
      bankCashLegs: number;
      cardLiabilityLegs: number;
      unpairedPayments: number;
      totalBankCashPaid: number;
    };
    inflowsAuditSummary: {
      totalInflows: number;
      sameOwnershipInflowsCount: number;
      thirdPartyInflowsCount: number;
      unprovedThirdPartyRevenueTotal: number;
    };
    discrepancy: number;
    creditCardPurchasesTotal: number;
    cardBillsCount: number;
  };
  identityStrategy: {
    countWithSourceId: number;
    countWithFallback: number;
    collisionsFound: number;
    potentialCollisions: number;
  };
  planArtifact: BackfillPlanArtifact;
  transactionAudits: TransactionResolutionAudit[];
  cardBillAudits: CardBillAuditItem[];
  categoryReconciliations: CategoryReconciliationItem[];
  proposedDerivedUpdates: ProposedDerivedUpdateAudit[];
  paymentLegAudits: PaymentLegAuditItem[];
  incomingTransferAudits: IncomingTransferAuditItem[];
  paymentEventAllocations: PaymentEventAllocation[];
  targetDriftReport?: TargetDriftReport;
}

export interface ValidatedSourceSession {
  restoredDbPath: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  manifestPath: string;
  cleanup: () => void;
}

export interface ValidatedTargetSession {
  payload: LiveDataSnapshotPayload;
  plaintextSha256: string;
  ciphertextSha256: string;
  manifestPath: string;
  frozenTargetStateHash: string;
  notionAccounts: any[];
  notionCategories: any[];
  cleanup: () => void;
}


export class BackfillDryRunAnalyzer {
  private client: Client;
  private envVars: Record<string, string | undefined>;
  private dbPath: string;
  private options: BackfillDryRunAnalyzerOptions;

  constructor(options: BackfillDryRunAnalyzerOptions = {}) {
    this.options = options;
    this.envVars = options.envVars ?? (process.env as Record<string, string | undefined>);
    this.dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'financial.db');

    const apiKey = options.apiKey ?? this.envVars.NOTION_API_KEY?.trim();
    this.client =
      options.client ??
      new Client({
        auth: apiKey,
        notionVersion: '2026-03-11',
      });
  }

  public prepareValidatedTargetSnapshot(): ValidatedTargetSession {
    const manifestPath =
      this.options.targetSnapshotManifestPath ??
      this.envVars.NOTION_TARGET_SNAPSHOT_MANIFEST?.trim() ??
      process.env.NOTION_TARGET_SNAPSHOT_MANIFEST?.trim();

    if (!manifestPath) {
      throw new Error(
        'FAIL_CLOSED_TARGET_SNAPSHOT: Caminho do manifesto do snapshot alvo não informado nem configurado em NOTION_TARGET_SNAPSHOT_MANIFEST.',
      );
    }
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `FAIL_CLOSED_TARGET_SNAPSHOT: Manifesto do snapshot alvo não encontrado em '${manifestPath}'.`,
      );
    }

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_TARGET_SNAPSHOT: Erro ao ler manifesto do snapshot alvo: ${err.message}`);
    }

    if (
      manifest.format !== 'FIN_ENC_V1' ||
      !manifest.encryptedFileSha256 ||
      !manifest.originalJsonSha256 ||
      !manifest.backupFileName ||
      manifest.totalBases !== 13
    ) {
      throw new Error(
        'FAIL_CLOSED_TARGET_SNAPSHOT: Manifesto do snapshot alvo inválido ou incompleto (format, hashes ou backupFileName ausentes).',
      );
    }

    const encryptedFilePath = path.resolve(path.dirname(manifestPath), manifest.backupFileName);
    if (!fs.existsSync(encryptedFilePath)) {
      throw new Error(
        `FAIL_CLOSED_TARGET_SNAPSHOT: Arquivo criptografado de snapshot alvo '${encryptedFilePath}' referenciado no manifesto não existe.`,
      );
    }

    const encryptedBuffer = fs.readFileSync(encryptedFilePath);
    const actualEncSha256 = crypto.createHash('sha256').update(encryptedBuffer).digest('hex');
    if (actualEncSha256 !== manifest.encryptedFileSha256) {
      throw new Error(
        `CORRUPTED_SNAPSHOT: Hash do arquivo criptografado (${actualEncSha256}) diverge do manifesto (${manifest.encryptedFileSha256}).`,
      );
    }

    const rawKey =
      this.envVars.MIGRATION_BACKUP_KEY ||
      process.env.MIGRATION_BACKUP_KEY ||
      this.envVars.AUDIT_ENCRYPTION_KEY ||
      process.env.AUDIT_ENCRYPTION_KEY;

    if (!rawKey || rawKey.trim().length === 0) {
      throw new Error(
        'FAIL_CLOSED_TARGET_SNAPSHOT: Chave de decodificação MIGRATION_BACKUP_KEY não informada para decifrar snapshot alvo.',
      );
    }

    const keyBuffer = parseKey32Bytes(rawKey, 'MIGRATION_BACKUP_KEY');

    const magicHeader = Buffer.from('FIN_ENC_V1', 'utf8');
    if (encryptedBuffer.length < magicHeader.length + 12 + 16) {
      throw new Error('CORRUPTED_SNAPSHOT: Arquivo de snapshot corrompido ou formato inválido: cabeçalho insuficiente.');
    }
    const magic = encryptedBuffer.subarray(0, magicHeader.length);
    if (!magic.equals(magicHeader)) {
      throw new Error('CORRUPTED_SNAPSHOT: Formato de snapshot inválido: cabeçalho mágico não reconhecido.');
    }

    const iv = encryptedBuffer.subarray(magicHeader.length, magicHeader.length + 12);
    const authTag = encryptedBuffer.subarray(magicHeader.length + 12, magicHeader.length + 12 + 16);
    const ciphertext = encryptedBuffer.subarray(magicHeader.length + 12 + 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(authTag);
    const decryptedBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const actualPlaintextSha = crypto.createHash('sha256').update(decryptedBuffer).digest('hex');
    if (actualPlaintextSha !== manifest.originalJsonSha256) {
      throw new Error(
        `CORRUPTED_SNAPSHOT: Hash do JSON restaurado (${actualPlaintextSha}) diverge do manifesto (${manifest.originalJsonSha256}).`,
      );
    }

    let parsedPayload: LiveDataSnapshotPayload | null = JSON.parse(decryptedBuffer.toString('utf8')) as LiveDataSnapshotPayload;
    if (parsedPayload.snapshotType !== 'NOTION_LIVE_DATA_SNAPSHOT' || parsedPayload.totalBases !== 13) {
      throw new Error('FAIL_CLOSED_TARGET_SNAPSHOT: Estrutura inválida no snapshot alvo restaurado.');
    }

    const frozenTargetStateHash = calculateTargetStateHash(parsedPayload.bases);
    const notionAccounts = extractNotionAccountsFromSnapshot(parsedPayload.bases['NOTION_DS_ACCOUNTS']?.records || []);
    const notionCategories = extractNotionCategoriesFromSnapshot(parsedPayload.bases['NOTION_DS_CATEGORIES']?.records || []);

    const cleanup = () => {
      parsedPayload = null;
    };

    return {
      payload: parsedPayload,
      plaintextSha256: manifest.originalJsonSha256,
      ciphertextSha256: manifest.encryptedFileSha256,
      manifestPath,
      frozenTargetStateHash,
      notionAccounts,
      notionCategories,
      cleanup,
    };
  }

  public calculateTargetDifferences(
    frozenBases: Record<string, BaseSnapshotData>,
    liveBases: Record<string, BaseSnapshotData>,
  ): TargetDriftDifference[] {
    const diffs: TargetDriftDifference[] = [];
    const allEnvKeys = new Set([...Object.keys(frozenBases), ...Object.keys(liveBases)]);

    for (const envKey of Array.from(allEnvKeys).sort()) {
      const frozenBase = frozenBases[envKey] || { records: [] };
      const liveBase = liveBases[envKey] || { records: [] };

      const frozenMap = new Map((frozenBase.records || []).map((r) => [r.id, r]));
      const liveMap = new Map((liveBase.records || []).map((r) => [r.id, r]));

      for (const liveRec of liveBase.records || []) {
        if (!frozenMap.has(liveRec.id)) {
          diffs.push({ envKey, pageId: liveRec.id, differenceType: 'PAGE_ADDED' });
        }
      }

      for (const frozenRec of frozenBase.records || []) {
        const liveRec = liveMap.get(frozenRec.id);
        if (!liveRec) {
          diffs.push({ envKey, pageId: frozenRec.id, differenceType: 'PAGE_REMOVED' });
          continue;
        }

        if (Boolean(frozenRec.archived) !== Boolean(liveRec.archived)) {
          diffs.push({ envKey, pageId: frozenRec.id, differenceType: 'ARCHIVED_STATUS_MODIFIED' });
        }

        const allProps = new Set([
          ...Object.keys(frozenRec.properties || {}),
          ...Object.keys(liveRec.properties || {}),
        ]);
        for (const prop of Array.from(allProps).sort()) {
          const fVal = JSON.stringify(canonicalizeValue(frozenRec.properties?.[prop]));
          const lVal = JSON.stringify(canonicalizeValue(liveRec.properties?.[prop]));
          if (fVal !== lVal) {
            diffs.push({
              envKey,
              pageId: frozenRec.id,
              differenceType: 'PROPERTY_MODIFIED',
              propertyName: prop,
            });
          }
        }
      }
    }
    return diffs;
  }

  public verifySnapshotReadiness(): {
    ciphertextIntegrityValid: boolean;
    manifestIntegrityValid: boolean;
    manifestStructureAndHashReferencesValid: boolean;
    plaintextRestoreVerified: boolean;
    frozenTargetStateHash?: string;
  } {
    try {
      const session = this.prepareValidatedTargetSnapshot();
      session.cleanup();
      return {
        ciphertextIntegrityValid: true,
        manifestIntegrityValid: true,
        manifestStructureAndHashReferencesValid: true,
        plaintextRestoreVerified: true,
        frozenTargetStateHash: session.frozenTargetStateHash,
      };
    } catch {
      return {
        ciphertextIntegrityValid: false,
        manifestIntegrityValid: false,
        manifestStructureAndHashReferencesValid: false,
        plaintextRestoreVerified: false,
      };
    }
  }


  public prepareValidatedSourceDatabase(): ValidatedSourceSession {
    const manifestPath =
      this.options.sourceSnapshotManifestPath ??
      this.envVars.SOURCE_SQLITE_SNAPSHOT_MANIFEST?.trim() ??
      process.env.SOURCE_SQLITE_SNAPSHOT_MANIFEST?.trim();

    if (!manifestPath) {
      throw new Error(
        'FAIL_CLOSED_SOURCE_SNAPSHOT: Caminho do manifesto do snapshot SQLite de origem não informado nem configurado em SOURCE_SQLITE_SNAPSHOT_MANIFEST.',
      );
    }
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `FAIL_CLOSED_SOURCE_SNAPSHOT: Manifesto do snapshot SQLite de origem não encontrado em '${manifestPath}'.`,
      );
    }

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_SOURCE_SNAPSHOT: Erro ao ler manifesto do snapshot SQLite: ${err.message}`);
    }

    if (
      manifest.format !== 'FIN_ENC_V1' ||
      !manifest.encryptedFileSha256 ||
      !manifest.originalDbSha256 ||
      !manifest.backupFileName
    ) {
      throw new Error(
        'FAIL_CLOSED_SOURCE_SNAPSHOT: Manifesto do snapshot SQLite inválido ou incompleto (format, hashes ou backupFileName ausentes).',
      );
    }

    const encryptedFilePath = path.resolve(path.dirname(manifestPath), manifest.backupFileName);
    if (!fs.existsSync(encryptedFilePath)) {
      throw new Error(
        `FAIL_CLOSED_SOURCE_SNAPSHOT: Arquivo criptografado de snapshot SQLite '${encryptedFilePath}' referenciado no manifesto não existe.`,
      );
    }

    const encryptedBuffer = fs.readFileSync(encryptedFilePath);
    const actualEncSha256 = crypto.createHash('sha256').update(encryptedBuffer).digest('hex');
    if (actualEncSha256 !== manifest.encryptedFileSha256) {
      throw new Error(
        `FAIL_CLOSED_SOURCE_SNAPSHOT: Hash do arquivo criptografado SQLite (${actualEncSha256}) diverge do manifesto (${manifest.encryptedFileSha256}).`,
      );
    }

    const rawKey =
      this.envVars.MIGRATION_BACKUP_KEY ||
      process.env.MIGRATION_BACKUP_KEY ||
      this.envVars.AUDIT_ENCRYPTION_KEY ||
      process.env.AUDIT_ENCRYPTION_KEY;

    if (!rawKey || rawKey.trim().length === 0) {
      throw new Error(
        'FAIL_CLOSED_SOURCE_SNAPSHOT: Chave de decodificação MIGRATION_BACKUP_KEY não informada para decifrar snapshot de origem.',
      );
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-source-snapshot-'));
    const tempPlaintextFile = path.join(tempDir, 'restored-source.db');

    const keyBuffer = parseKey32Bytes(rawKey, 'MIGRATION_BACKUP_KEY');


    try {
      const backupMgr = new FinancialBackupManager({ dbPath: tempPlaintextFile, key: rawKey });
      const decryptedBuffer = backupMgr.decryptBackupBuffer(encryptedBuffer, keyBuffer);
      fs.writeFileSync(tempPlaintextFile, decryptedBuffer);

      const actualPlaintextSha = crypto.createHash('sha256').update(decryptedBuffer).digest('hex');
      if (actualPlaintextSha !== manifest.originalDbSha256) {
        throw new Error(
          `FAIL_CLOSED_SOURCE_SNAPSHOT: Hash do banco SQLite restaurado (${actualPlaintextSha}) diverge do manifesto (${manifest.originalDbSha256}).`,
        );
      }

      const verificationDb = new Database(tempPlaintextFile, { readonly: true });
      try {
        const pragmaRes = verificationDb.pragma('integrity_check') as any[];
        const integrityOk =
          pragmaRes &&
          pragmaRes.length > 0 &&
          (pragmaRes[0].integrity_check === 'ok' || Object.values(pragmaRes[0])[0] === 'ok');

        if (!integrityOk) {
          throw new Error('FAIL_CLOSED_SOURCE_SNAPSHOT: PRAGMA integrity_check falhou no snapshot restaurado.');
        }

        const txCountRes = verificationDb.prepare('SELECT count(*) as count FROM transactions').get() as any;
        if (!txCountRes || txCountRes.count <= 0) {
          throw new Error('FAIL_CLOSED_SOURCE_SNAPSHOT: Tabela transactions vazia ou inexistente no snapshot.');
        }
      } finally {
        verificationDb.close();
      }

      const cleanup = () => {
        try {
          if (fs.existsSync(tempPlaintextFile)) {
            fs.unlinkSync(tempPlaintextFile);
          }
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch {
          // ignore cleanup errors
        }
      };

      return {
        restoredDbPath: tempPlaintextFile,
        plaintextSha256: manifest.originalDbSha256,
        ciphertextSha256: manifest.encryptedFileSha256,
        manifestPath,
        cleanup,
      };
    } catch (err) {
      try {
        if (fs.existsSync(tempPlaintextFile)) {
          fs.unlinkSync(tempPlaintextFile);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
      throw err;
    }
  }

  public verifySourceSnapshotReadiness(): {
    sourceSnapshotCiphertextValid: boolean;
    sourceSnapshotManifestValid: boolean;
    sourceSnapshotRestoreVerified: boolean;
    manifestPath: string;
    sourceSnapshotPlaintextSha256?: string;
    sourceSnapshotEncryptedSha256?: string;
  } {
    const manifestPath =
      this.options.sourceSnapshotManifestPath ??
      this.envVars.SOURCE_SQLITE_SNAPSHOT_MANIFEST?.trim() ??
      process.env.SOURCE_SQLITE_SNAPSHOT_MANIFEST?.trim() ??
      '';

    try {
      const session = this.prepareValidatedSourceDatabase();
      session.cleanup();
      return {
        sourceSnapshotCiphertextValid: true,
        sourceSnapshotManifestValid: true,
        sourceSnapshotRestoreVerified: true,
        manifestPath: session.manifestPath,
        sourceSnapshotPlaintextSha256: session.plaintextSha256,
        sourceSnapshotEncryptedSha256: session.ciphertextSha256,
      };
    } catch {
      return {
        sourceSnapshotCiphertextValid: false,
        sourceSnapshotManifestValid: false,
        sourceSnapshotRestoreVerified: false,
        manifestPath,
      };
    }
  }

  public async runAnalysis(): Promise<BackfillDryRunReport> {
    const timestampIso = new Date().toISOString();

    const accountsDsId = this.envVars.NOTION_DS_ACCOUNTS?.trim();
    const categoriesDsId = this.envVars.NOTION_DS_CATEGORIES?.trim();

    if (!accountsDsId || !categoriesDsId) {
      throw new Error('FAIL_CLOSED_ENV: NOTION_DS_ACCOUNTS e NOTION_DS_CATEGORIES devem estar configurados.');
    }

    let targetSession: ValidatedTargetSession | null = null;
    let sourceSession: ValidatedSourceSession | null = null;
    let activeDb: Database.Database | null = null;

    try {
      // 1. Prepare validated target snapshot from frozen snapshot (FAIL-CLOSED, ANTI-TOCTOU)
      // The Backfill Plan is built EXCLUSIVELY against this frozen snapshot; live Notion is never used to build operations.
      targetSession = this.prepareValidatedTargetSnapshot();
      sourceSession = this.prepareValidatedSourceDatabase();

      if (this.options._deliberateErrorAfterRestore) {
        throw new Error('DELIBERATE_TEST_ERROR_AFTER_RESTORE: Simulação de falha posterior ao restore para validação de cleanup.');
      }

      activeDb = new Database(sourceSession.restoredDbPath, { readonly: true });
      const sqliteAccounts = activeDb.prepare('SELECT * FROM accounts').all() as any[];
      const sqliteTransactions = activeDb.prepare('SELECT * FROM transactions ORDER BY date ASC, id ASC').all() as any[];

      // 2. Read-Only Notion Live Drift Proof (Fail-Closed)
      let targetDriftReport: TargetDriftReport | undefined = undefined;
      let targetLiveDriftZero = false;

      if (this.options.liveBases) {
        const liveTargetStateHash = calculateTargetStateHash(this.options.liveBases);
        const driftDetected = liveTargetStateHash !== targetSession.frozenTargetStateHash;
        const differences = this.calculateTargetDifferences(targetSession.payload.bases, this.options.liveBases);
        targetDriftReport = {
          frozenTargetStateHash: targetSession.frozenTargetStateHash,
          liveTargetStateHash,
          driftDetected,
          differences,
        };
        targetLiveDriftZero = !driftDetected;
      } else if (!this.options.skipLiveDriftCheck && (this.options.apiKey || this.envVars.NOTION_API_KEY)) {
        try {
          const snapshotMgr = new NotionLiveDataSnapshotManager({
            client: this.client,
            apiKey: this.options.apiKey || this.envVars.NOTION_API_KEY,
            envVars: this.envVars,
          });
          const liveBases: Record<string, BaseSnapshotData> = {};
          for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
            const dsId = this.envVars[contract.envKey]?.trim();
            if (!dsId) continue;
            const records = await snapshotMgr.fetchBaseRecords(contract.envKey, dsId);
            liveBases[contract.envKey] = {
              envKey: contract.envKey,
              defaultTitle: contract.defaultTitle,
              dataSourceId: dsId,
              recordCount: records.length,
              records,
            };
          }
          if (Object.keys(liveBases).length === 13) {
            const liveTargetStateHash = calculateTargetStateHash(liveBases);
            const driftDetected = liveTargetStateHash !== targetSession.frozenTargetStateHash;
            const differences = this.calculateTargetDifferences(targetSession.payload.bases, liveBases);
            targetDriftReport = {
              frozenTargetStateHash: targetSession.frozenTargetStateHash,
              liveTargetStateHash,
              driftDetected,
              differences,
            };
            targetLiveDriftZero = !driftDetected;
          }
        } catch {
          // Live drift proof unverified (offline or network error)
        }
      }

      // 3. Obtain Schema Conformance Evidence if available
      let schemaEvidence = this.options.schemaEvidence;
      if (!schemaEvidence && (this.options.apiKey || this.envVars.NOTION_API_KEY)) {
        try {
          const validator = new NotionSchemaValidator(this.options.apiKey || this.envVars.NOTION_API_KEY);
          const introspection = await validator.runIntrospection(this.envVars, { treatAllAsExisting: true });
          const missingPropertiesCount = Object.values(introspection.results).reduce(
            (acc, r) => acc + r.properties.filter((p) => p.status === 'MISSING').length,
            0,
          );
          const structuralMismatchesCount = Object.values(introspection.results).reduce(
            (acc, r) =>
              acc +
              r.properties.filter((p) => p.status === 'TYPE_MISMATCH' || p.status === 'RENAME_TYPE_MISMATCH').length,
            0,
          );
          schemaEvidence = {
            totalDataSources: introspection.totalCanonical,
            verifiedDataSources: introspection.verifiedCount,
            missingPropertiesCount,
            structuralMismatchesCount,
          };
        } catch {
          // In unit tests or offline runs without network, schemaEvidence remains undefined
        }
      }

      const snapshotValidation = {
        ciphertextIntegrityValid: true,
        manifestIntegrityValid: true,
        manifestStructureAndHashReferencesValid: true,
        plaintextRestoreVerified: true,
        frozenTargetStateHash: targetSession.frozenTargetStateHash,
        targetLiveDriftZero,
        sourceSnapshotCiphertextValid: true,
        sourceSnapshotManifestValid: true,
        sourceSnapshotRestoreVerified: true,
        sourceSnapshotPlaintextSha256: sourceSession.plaintextSha256,
        sourceSnapshotEncryptedSha256: sourceSession.ciphertextSha256,
        sourceSnapshotManifestPath: sourceSession.manifestPath,
      };

      // 4. Resolve Planner Config (External config required, zero silent defaults)
      let plannerConfig = this.options.plannerConfig;
      if (!plannerConfig) {
        try {
          const resolved = resolvePlannerConfig(
            undefined,
            this.envVars,
          );
          plannerConfig = resolved.effectiveConfig;
        } catch {
          // Will fail-closed inside planner if needed
        }
      }

      // 5. Generate deterministic BackfillPlanArtifact and audits from frozen target metadata
      const planner = new BackfillPlanner({ dbPath: sourceSession.restoredDbPath, envVars: this.envVars });
      const {
        artifact: planArtifact,
        transactionAudits,
        cardBillAudits,
        categoryReconciliations,
        proposedDerivedUpdates,
        paymentLegAudits,
        incomingTransferAudits,
        paymentEventAllocations,
      } = planner.generateArtifact({
        dbPath: sourceSession.restoredDbPath,
        envVars: this.envVars,
        commitSha: this.options.commitSha,
        targetSnapshotManifestPath: targetSession.manifestPath,
        targetNotionSnapshotHash: this.options.targetNotionSnapshotHash || targetSession.plaintextSha256,
        targetStateHash: targetSession.frozenTargetStateHash,
        targetLiveDriftZero,
        plannerConfig,
        snapshotValidation,
        notionAccounts: targetSession.notionAccounts,
        notionCategories: targetSession.notionCategories,
        schemaEvidence,
      });


    // 5. Detailed Temporal & Financial Reconciliation (Decoupled Physical vs Liability vs Economic)
    let minDate = sqliteTransactions[0]?.date ?? '';
    let maxDate = sqliteTransactions[0]?.date ?? '';
    const countByMonth: Record<string, number> = {};
    const byNature: Record<string, { count: number; sum: number }> = {};
    const byBudgetEffect: Record<string, { count: number; sum: number }> = {};

    const checkingTxs = sqliteTransactions.filter((t) => t.account_type === 'BANK');
    const cardTxs = sqliteTransactions.filter((t) => t.account_type === 'CREDIT');

    // 5.1. Checking Cash Flow
    let checkingInflows = 0;
    let thirdPartyInflows = 0;
    let sameOwnershipInflows = 0;
    let directCheckingExpenses = 0;
    let outgoingInternalTransfers = 0;
    let cardBillSettlementOutflows = 0;
    let pendingOutflows = 0;
    const bankPaymentTxs = checkingTxs.filter(
      (tx) =>
        Number(tx.amount) < 0 &&
        (tx.description?.toLowerCase().includes('pagamento') ||
          tx.category_pierre?.toLowerCase().includes('pagamento')),
    );

    for (const tx of checkingTxs) {
      if (tx.date < minDate) minDate = tx.date;
      if (tx.date > maxDate) maxDate = tx.date;
      const m = tx.date.substring(0, 7);
      countByMonth[m] = (countByMonth[m] || 0) + 1;

      const amt = Number(tx.amount);
      const descLower = tx.description?.toLowerCase() || '';
      const pierreLower = (tx.category_pierre || '').toLowerCase().trim();
      const mappedLower = (tx.category_mapped || '').toLowerCase().trim();
      const raw = JSON.parse(tx.raw_json || '{}');
      const rawCatLower = ((raw.category as string) || '').toLowerCase().trim();
      const isSame =
        pierreLower.includes('mesma titularidade') ||
        rawCatLower.includes('mesma titularidade');

      if (amt > 0) {
        checkingInflows += amt;
        if (isSame) sameOwnershipInflows += amt;
        else thirdPartyInflows += amt;
      } else {
        const isBillPayment =
          descLower.includes('pagamento') ||
          pierreLower.includes('pagamento');
        const lookupKey = `${mappedLower} || ${pierreLower}`;
        const isThirdPartyTransfer =
          lookupKey === '(transferência) || transferências' ||
          (mappedLower === '(transferência)' && descLower.startsWith('transferência enviada'));

        if (isBillPayment) {
          cardBillSettlementOutflows += Math.abs(amt);
        } else if (isSame) {
          outgoingInternalTransfers += Math.abs(amt);
        } else if (isThirdPartyTransfer) {
          pendingOutflows += Math.abs(amt);
        } else {
          directCheckingExpenses += Math.abs(amt);
        }
      }

      const op = planArtifact.operations.find((o) => o.stableId === tx.id);
      const nature = op?.sanitizedPayload['Natureza'] || 'Pendente';
      const effect = op?.sanitizedPayload['Efeito Orçamentário'] || 'Pendente';

      byNature[nature] = byNature[nature] || { count: 0, sum: 0 };
      byNature[nature].count++;
      byNature[nature].sum += Math.abs(amt);

      byBudgetEffect[effect] = byBudgetEffect[effect] || { count: 0, sum: 0 };
      byBudgetEffect[effect].count++;
      byBudgetEffect[effect].sum += Math.abs(amt);
    }

    const totalCheckingOutflows = directCheckingExpenses + outgoingInternalTransfers + cardBillSettlementOutflows + pendingOutflows;
    const netCheckingCashFlow = checkingInflows - totalCheckingOutflows;

    // 5.2. Card Liability
    const cardPurchases = cardTxs.filter(
      (t) =>
        !t.description?.toLowerCase().includes('pagamento') &&
        (!t.category_pierre || !t.category_pierre.toLowerCase().includes('pagamento')),
    );
    const cardPayments = cardTxs.filter(
      (t) =>
        t.description?.toLowerCase().includes('pagamento') ||
        (t.category_pierre && t.category_pierre.toLowerCase().includes('pagamento')),
    );

    for (const tx of cardTxs) {
      if (tx.date < minDate) minDate = tx.date;
      if (tx.date > maxDate) maxDate = tx.date;
      const m = tx.date.substring(0, 7);
      countByMonth[m] = (countByMonth[m] || 0) + 1;

      const amt = Number(tx.amount);
      const op = planArtifact.operations.find((o) => o.stableId === tx.id);
      const nature = op?.sanitizedPayload['Natureza'] || 'Pendente';
      const effect = op?.sanitizedPayload['Efeito Orçamentário'] || 'Pendente';

      byNature[nature] = byNature[nature] || { count: 0, sum: 0 };
      byNature[nature].count++;
      byNature[nature].sum += Math.abs(amt);

      byBudgetEffect[effect] = byBudgetEffect[effect] || { count: 0, sum: 0 };
      byBudgetEffect[effect].count++;
      byBudgetEffect[effect].sum += Math.abs(amt);
    }

    const totalPurchasesAmount = cardPurchases.reduce((acc, t) => acc + Math.abs(Number(t.amount)), 0);
    const totalPaymentsAmount = cardPayments.reduce((acc, t) => acc + Math.abs(Number(t.amount)), 0);

    // 5.3. Economic Consumption: Direct Checking Expenses + Card Purchases
    const totalEconomicExpenses = directCheckingExpenses + totalPurchasesAmount;
    const confirmedEconomicIncome = 0; // Third-party inflows are pending classification

    // 6. Identity Strategy Check
    const countWithSourceId = sqliteTransactions.length;
    const countWithFallback = 0;
    const uniqueStableIds = new Set(planArtifact.operations.map((o) => o.stableId));
    const collisionsFound = planArtifact.operations.length - uniqueStableIds.size;

    // 7. Base Analyses (derived dynamically from frozen target snapshot)
    const accountsCount = targetSession.payload.bases['NOTION_DS_ACCOUNTS']?.recordCount ?? 0;
    const txCount = targetSession.payload.bases['NOTION_DS_TRANSACTIONS']?.recordCount ?? 0;
    const cardBillsCount = targetSession.payload.bases['NOTION_DS_CARD_BILLS']?.recordCount ?? 0;
    const budgetCount = targetSession.payload.bases['NOTION_DS_MONTHLY_BUDGET']?.recordCount ?? 0;

    const contasAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_ACCOUNTS',
      databaseTitle: 'Contas',
      currentNotionRows: accountsCount,
      rowsToCreate: 0,
      rowsToUpdate: 0,
      rowsUnchanged: accountsCount,
      relationsToPopulate: {},
      duplicatesDetected: 0,
      ambiguousItems: [],
    };

    const txAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_TRANSACTIONS',
      databaseTitle: 'Transações',
      currentNotionRows: txCount,
      rowsToCreate: sqliteTransactions.length,
      rowsToUpdate: 0,
      rowsUnchanged: txCount,
      relationsToPopulate: {
        Conta: sqliteTransactions.length,
        Categoria: sqliteTransactions.length - incomingTransferAudits.filter((t) => t.counterpartyType !== 'SAME_OWNERSHIP_TRANSFER').length,
        'Fatura Vinculada': cardPurchases.length,
      },
      duplicatesDetected: 0,
      ambiguousItems: [],
    };

    const cardBillsAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_CARD_BILLS',
      databaseTitle: 'Faturas / Ciclos de Cartão',
      currentNotionRows: cardBillsCount,
      rowsToCreate: cardBillAudits.length,
      rowsToUpdate: 0,
      rowsUnchanged: cardBillsCount,
      relationsToPopulate: {
        'Cartão Vinculado': cardBillAudits.length,
        'Lançamentos do Ciclo': cardPurchases.length,
        'Transações de Pagamento': paymentEventAllocations.filter((a) => a.method !== 'UNRESOLVED_PAYMENT_ALLOCATION').length,
      },
      duplicatesDetected: 0,
      ambiguousItems: [],
      financialTotals: {
        totalPurchasesAcrossCycles: Math.round(totalPurchasesAmount * 100) / 100,
      },
    };

    const budgetAnalysis: BackfillBaseAnalysis = {
      envKey: 'NOTION_DS_MONTHLY_BUDGET',
      databaseTitle: 'Planejamento Mensal',
      currentNotionRows: budgetCount,
      rowsToCreate: 0,
      rowsToUpdate: 0,
      rowsUnchanged: budgetCount,
      relationsToPopulate: {},
      duplicatesDetected: 0,
      ambiguousItems: [],
    };

    const basesAnalysis: Record<string, BackfillBaseAnalysis> = {
      NOTION_DS_ACCOUNTS: contasAnalysis,
      NOTION_DS_TRANSACTIONS: txAnalysis,
      NOTION_DS_CARD_BILLS: cardBillsAnalysis,
      NOTION_DS_MONTHLY_BUDGET: budgetAnalysis,
    };

    const totalRowsToCreate = planArtifact.summary.executableCreateCount;
    const totalRowsToUpdate = planArtifact.summary.executableUpdateCount;
    const totalRelationsToPopulate = planArtifact.summary.totalRelations;

      return {
        timestampIso,
        sourceDatabase: sourceSession.restoredDbPath,
        totalSourceTransactions: sqliteTransactions.length,
        totalSourceAccounts: sqliteAccounts.length,
        basesAnalysis,
        summary: {
          totalRowsToCreate,
          totalRowsToUpdate,
          totalRelationsToPopulate,
          totalDuplicates: 0,
          totalAmbiguities: 0,
        },
        reconciliation: {
          minDate,
          maxDate,
          countByMonth,
          byNature,
          byBudgetEffect,
          checkingCashFlow: {
            inflowsTotal: Math.round(checkingInflows * 100) / 100,
            thirdPartyInflows: Math.round(thirdPartyInflows * 100) / 100,
            sameOwnershipInflows: Math.round(sameOwnershipInflows * 100) / 100,
            directOutflows: Math.round(directCheckingExpenses * 100) / 100,
            outgoingInternalTransfers: Math.round(outgoingInternalTransfers * 100) / 100,
            cardBillSettlementOutflows: Math.round(cardBillSettlementOutflows * 100) / 100,
            pendingOutflows: Math.round(pendingOutflows * 100) / 100,
            totalOutflows: Math.round(totalCheckingOutflows * 100) / 100,
            netCashFlow: Math.round(netCheckingCashFlow * 100) / 100,
          },
          cardLiability: {
            totalPurchases: Math.round(totalPurchasesAmount * 100) / 100,
            purchasesCount: cardPurchases.length,
            paymentsCreditsRecorded: Math.round(totalPaymentsAmount * 100) / 100,
            paymentsCreditsCount: cardPayments.length,
          },
          economicConsumption: {
            directCheckingExpenses: Math.round(directCheckingExpenses * 100) / 100,
            cardPurchases: Math.round(totalPurchasesAmount * 100) / 100,
            totalEconomicExpenses: Math.round(totalEconomicExpenses * 100) / 100,
            confirmedEconomicExpenses: Math.round(totalEconomicExpenses * 100) / 100,
            pendingEconomicOutflows: Math.round(pendingOutflows * 100) / 100,
            physicalCashOutflows: Math.round(totalCheckingOutflows * 100) / 100,
            economicIncome: confirmedEconomicIncome,
            pendingThirdPartyInflows: Math.round(thirdPartyInflows * 100) / 100,
            neutralSettlements: Math.round(cardBillSettlementOutflows * 100) / 100,
            neutralTransfers: Math.round((sameOwnershipInflows + outgoingInternalTransfers) * 100) / 100,
          },
          paymentAuditSummary: {
            totalPaymentOccurrences: bankPaymentTxs.length + cardPayments.length,
            bankCashLegs: bankPaymentTxs.length,
            cardLiabilityLegs: paymentLegAudits.filter((l) => l.role === 'CARD_LIABILITY_LEG').length,
            unpairedPayments: paymentLegAudits.filter((l) => l.role === 'UNPAIRED_PAYMENT').length,
            totalBankCashPaid: Math.round(cardBillSettlementOutflows * 100) / 100,
          },
          inflowsAuditSummary: {
            totalInflows: checkingInflows > 0 ? checkingTxs.filter((t) => Number(t.amount) > 0).length : 0,
            sameOwnershipInflowsCount: incomingTransferAudits.filter((t) => t.counterpartyType === 'SAME_OWNERSHIP_TRANSFER').length,
            thirdPartyInflowsCount: incomingTransferAudits.filter((t) => t.counterpartyType !== 'SAME_OWNERSHIP_TRANSFER').length,
            unprovedThirdPartyRevenueTotal: Math.round(thirdPartyInflows * 100) / 100,
          },
          discrepancy: 0,
          creditCardPurchasesTotal: Math.round(totalPurchasesAmount * 100) / 100,
          cardBillsCount: cardBillAudits.length,
        },
        identityStrategy: {
          countWithSourceId,
          countWithFallback,
          collisionsFound,
          potentialCollisions: 0,
        },
        planArtifact,
        transactionAudits,
        cardBillAudits,
        categoryReconciliations,
        proposedDerivedUpdates,
        paymentLegAudits,
        incomingTransferAudits,
        paymentEventAllocations,
        targetDriftReport,
      };
    } finally {
      if (activeDb) {
        try {
          activeDb.close();
        } catch {
          // ignore
        }
      }
      try {
        sourceSession?.cleanup();
      } catch {
        // ignore
      }
      try {
        targetSession?.cleanup();
      } catch {
        // ignore
      }
    }

  }
}
