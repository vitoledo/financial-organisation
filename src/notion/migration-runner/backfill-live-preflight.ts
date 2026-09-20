/**
 * Fase 2C — Preflight Real Read-Only e Verificação Rigorosa do Ambiente Live Notion
 *
 * REGRA CENTRAL:
 * ZERO CREATE live
 * ZERO UPDATE live
 * ZERO DELETE live
 * ZERO archive live
 * readyForApply = false
 *
 * Este módulo prova que o ambiente real do Notion está 100% em conformidade com o
 * plano congelado e pronto para a homologação de auditoria prévia à Fase 2D.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { findPropertyContract } from './backfill-serializer';
import { NotionSchemaValidator } from '../schema-validator';
import { LiveNotionAdapter } from './backfill-adapter';
import { calculateTargetStateHash, BaseSnapshotData } from './data-snapshot';
import { BackfillDryRunAnalyzer } from './backfill-dry-run';
import {
  PLAN_ORIGIN_COMMIT_SHA,
  FROZEN_BACKFILL_PLAN_HASH,
  FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256,
  FROZEN_TARGET_STATE_HASH,
} from './backfill-constants';
import { BackfillSchemaConformanceEvidence, BackfillOperation, TypedRelationReference } from './types';

export interface LivePreflightOptions {
  client?: Client;
  envVars?: Record<string, string | undefined>;
  planOriginCommitSha?: string;
  artifactPath?: string;
  journalPath?: string;
  ttlMinutes?: number;
}

export interface LivePreflightArtifact {
  preflightVersion: string;
  timestamp: string;
  generatedAt: string;
  expiresAt: string;
  ttlMinutes: number;
  executorCommitSha: string;
  executorParentCommitSha: string;
  planOriginCommitSha: string;
  backfillPlanHash: string;
  sourceSnapshotHash: string;
  targetSnapshotHash: string;
  frozenTargetStateHash: string;
  liveTargetStateHash: string;
  workspaceIdentityHash: string;
  actorType: string;
  schema: {
    total: number;
    verified: number;
    missing: number;
    mismatches: number;
  };
  targets: {
    transactions: number;
    bills: number;
  };
  stableIdentityConflicts: number;
  relationTargetErrors: number;
  liveMutations: number;
  readyForLiveApplyReview: boolean;
  readyForApply: boolean;
  reasons: string[];
  rowCountsByDataSource: Record<string, number>;
  existingRelationsSummary: {
    total: number;
    verified: number;
    missing: number;
    wrongTarget: number;
  };
  stableIdentitiesSummary: {
    totalChecked: number;
    conflicts: number;
    duplicates: number;
  };
  journalStatus: {
    path: string;
    exists: boolean;
    writable: boolean;
    gitIgnored: boolean;
    existingRunsCount?: number;
  };
  structuralDiff?: Array<{
    envKey: string;
    pageIdPseudonym: string;
    property: string;
    differenceType: string;
  }>;
}

export class BackfillLivePreflight {
  private client?: Client;
  private envVars: Record<string, string | undefined>;
  private planOriginSha: string;
  private artifactPath: string;
  private journalPath: string;
  private ttlMinutes: number;

  constructor(options: LivePreflightOptions = {}) {
    this.envVars = options.envVars || (process.env as Record<string, string | undefined>);
    this.planOriginSha = options.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;
    this.artifactPath = options.artifactPath || path.resolve(process.cwd(), '.local', 'backfill-live-preflight.json');
    this.journalPath = options.journalPath || path.resolve(process.cwd(), '.local', 'backfill-live-journal.db');
    this.ttlMinutes = options.ttlMinutes ?? 15;

    const apiKey = this.envVars.NOTION_API_KEY?.trim();
    this.client =
      options.client ||
      (apiKey
        ? new Client({
            auth: apiKey,
            notionVersion: '2026-03-11',
          })
        : undefined);
  }

  private getGitCommitSha(): string {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown-executor-sha';
    }
  }

  private getGitParentSha(): string {
    try {
      return execSync('git rev-parse HEAD~1', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown-parent-sha';
    }
  }

  /**
   * Executes full Phase 2C read-only preflight against the live Notion workspace.
   */
  public async executePreflight(): Promise<LivePreflightArtifact> {
    const reasons: string[] = [];
    const now = new Date();
    const generatedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMinutes * 60 * 1000).toISOString();

    const executorCommitSha = this.getGitCommitSha();
    const executorParentCommitSha = this.getGitParentSha();

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Conectividade e Identidade do Workspace (Item 3)
    // ─────────────────────────────────────────────────────────────────────────
    if (!this.client) {
      throw new Error('FAIL_NOTION_AUTH: NOTION_API_KEY ausente ou cliente Notion não inicializado.');
    }

    let actorType = 'unknown';
    let workspaceIdentityHash = '';

    try {
      const me = await this.client.users.me({});
      actorType = me.type || (me as any).object || 'bot';
      const rawWorkspaceId = (me as any).bot?.workspace_id || (me as any).bot?.workspace_name || me.id;
      workspaceIdentityHash = crypto.createHash('sha256').update(rawWorkspaceId).digest('hex');
    } catch (err: any) {
      const status = err?.status || err?.code;
      if (status === 401 || status === 403) {
        throw new Error(
          `FAIL_NOTION_AUTH: Autenticação/autorização falhou na Notion API (${status}): ${err.message}`,
        );
      }
      throw new Error(`FAIL_LIVE_TARGET_READ: Conectividade com Notion API falhou: ${err.message}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Validação Real do Schema LIVE (Item 5)
    // ─────────────────────────────────────────────────────────────────────────
    const apiKey = this.envVars.NOTION_API_KEY?.trim() || '';
    const schemaValidator = new NotionSchemaValidator(apiKey);
    const introspectionReport = await schemaValidator.runIntrospection(this.envVars, { treatAllAsExisting: true });

    let missingPropertiesCount = 0;
    let structuralMismatchesCount = 0;

    for (const [key, dDiff] of Object.entries(introspectionReport.results)) {
      if (dDiff.status === 'MISSING_ENV_ID' || dDiff.status === 'API_ERROR' || dDiff.status === 'UNVERIFIED_NO_KEY') {
        reasons.push(`FAIL_SCHEMA_NON_CONFORMANT: Data source ${key} com status de conexão inválido: ${dDiff.status}`);
      }
      for (const p of dDiff.properties) {
        if (p.status === 'MISSING') {
          missingPropertiesCount++;
        } else if (
          p.status === 'STRUCTURAL_MISMATCH' ||
          p.status === 'TYPE_MISMATCH' ||
          p.status === 'RENAME_STRUCTURAL_MISMATCH' ||
          p.status === 'RENAME_TYPE_MISMATCH'
        ) {
          structuralMismatchesCount++;
        }
      }
    }

    // Validação explícita da dual relation: Faturas."Lançamentos do Ciclo" <-> Transações."Fatura Vinculada"
    const billsDiff = introspectionReport.results['NOTION_DS_CARD_BILLS'];
    const txDiff = introspectionReport.results['NOTION_DS_TRANSACTIONS'];
    const cycleRel = billsDiff?.properties.find((p) => p.notionProperty === 'Lançamentos do Ciclo');
    const billRel = txDiff?.properties.find((p) => p.notionProperty === 'Fatura Vinculada');

    if (!cycleRel || cycleRel.status !== 'EXACT_MATCH' || cycleRel.structuralDetails?.actualRelationType !== 'dual_property') {
      reasons.push(
        'FAIL_SCHEMA_NON_CONFORMANT: Relação dual "Lançamentos do Ciclo" na base de Faturas não é dual_property exata.',
      );
      structuralMismatchesCount++;
    }

    if (!billRel || (billRel.status !== 'EXACT_MATCH' && billRel.status !== 'RENAME_CANDIDATE')) {
      reasons.push('FAIL_SCHEMA_NON_CONFORMANT: Relação "Fatura Vinculada" na base de Transações divergente do contrato.');
      structuralMismatchesCount++;
    }

    const schemaEvidence: BackfillSchemaConformanceEvidence = {
      totalDataSources: introspectionReport.totalCanonical,
      verifiedDataSources: introspectionReport.verifiedCount,
      missingPropertiesCount,
      structuralMismatchesCount,
    };

    if (schemaEvidence.verifiedDataSources !== 13 || schemaEvidence.missingPropertiesCount > 0 || schemaEvidence.structuralMismatchesCount > 0) {
      reasons.push(
        `FAIL_SCHEMA_NON_CONFORMANT: Schema live diverge do TARGET_CONTRACT (${schemaEvidence.verifiedDataSources}/13 verificadas, ${missingPropertiesCount} ausentes, ${structuralMismatchesCount} mismatches).`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Leitura das 13 Bases Reais com Paginação Completa (Item 4)
    // ─────────────────────────────────────────────────────────────────────────
    const liveAdapter = new LiveNotionAdapter(this.client, this.envVars);
    let liveTargetBases: Record<string, BaseSnapshotData>;

    try {
      liveTargetBases = await liveAdapter.queryTargetState();
    } catch (err: any) {
      throw new Error(`FAIL_LIVE_TARGET_READ: Falha na leitura paginada das 13 bases live: ${err.message}`);
    }

    const liveBasesKeys = Object.keys(liveTargetBases);
    if (liveBasesKeys.length !== 13) {
      throw new Error(`FAIL_LIVE_TARGET_READ: Esperado 13 bases no Notion live, obtido ${liveBasesKeys.length}.`);
    }

    const rowCountsByDataSource: Record<string, number> = {};
    for (const [k, baseData] of Object.entries(liveTargetBases)) {
      rowCountsByDataSource[k] = baseData.recordCount;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Confirmar Estado Pristine das Bases que Receberão DML (Item 7)
    // ─────────────────────────────────────────────────────────────────────────
    const txRowCount = liveTargetBases['NOTION_DS_TRANSACTIONS']?.recordCount ?? 0;
    const billsRowCount = liveTargetBases['NOTION_DS_CARD_BILLS']?.recordCount ?? 0;

    if (txRowCount > 0 || billsRowCount > 0) {
      reasons.push(
        `PREEXISTING_BACKFILL_TARGET_DATA: Bases de escrita contêm dados prévios (Transações: ${txRowCount}, Faturas: ${billsRowCount}). O apply real exige 0 linhas.`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Comparar Estado Live com Snapshot Congelado (Item 6)
    // ─────────────────────────────────────────────────────────────────────────
    const liveTargetStateHash = calculateTargetStateHash(liveTargetBases);
    const structuralDiff: Array<{
      envKey: string;
      pageIdPseudonym: string;
      property: string;
      differenceType: string;
    }> = [];

    if (liveTargetStateHash !== FROZEN_TARGET_STATE_HASH) {
      reasons.push(
        `TARGET_DRIFT_DETECTED: liveTargetStateHash (${liveTargetStateHash}) diverge do snapshot congelado (${FROZEN_TARGET_STATE_HASH}).`,
      );

      // Gerar diff estrutural sanitizado sem dados financeiros
      for (const [key, baseData] of Object.entries(liveTargetBases)) {
        if (key === 'NOTION_DS_TRANSACTIONS' || key === 'NOTION_DS_CARD_BILLS') {
          if (baseData.recordCount > 0) {
            for (const r of baseData.records) {
              structuralDiff.push({
                envKey: key,
                pageIdPseudonym: crypto.createHash('sha256').update(r.id).digest('hex').substring(0, 12),
                property: '__RECORD__',
                differenceType: 'UNEXPECTED_PREEXISTING_PAGE',
              });
            }
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Reproduzir o BackfillPlan a partir dos Snapshots Congelados (Item 8)
    // ─────────────────────────────────────────────────────────────────────────
    const targetAnalyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: this.planOriginSha,
      schemaEvidence,
    });
    const targetSession = targetAnalyzer.prepareValidatedTargetSnapshot();
    const frozenBases: Record<string, BaseSnapshotData> = JSON.parse(JSON.stringify(targetSession.payload.bases));
    targetSession.cleanup();

    const analyzer = new BackfillDryRunAnalyzer({
      envVars: this.envVars,
      commitSha: this.planOriginSha,
      schemaEvidence,
      liveBases: frozenBases,
    });

    const analysisReport = await analyzer.runAnalysis();
    const plan = analysisReport.planArtifact;

    if (plan.backfillPlanHash !== FROZEN_BACKFILL_PLAN_HASH) {
      reasons.push(
        `FAIL_FROZEN_PLAN_MISMATCH: reproducedBackfillPlanHash (${plan.backfillPlanHash}) diverge do hash congelado (${FROZEN_BACKFILL_PLAN_HASH}).`,
      );
    }

    if (plan.summary.executableCreateCount !== 159 || plan.summary.executableUpdateCount !== 0) {
      reasons.push(
        `FAIL_PLAN_COUNTS_MISMATCH: Esperado 159 CREATE e 0 UPDATE, obtido ${plan.summary.executableCreateCount} / ${plan.summary.executableUpdateCount}.`,
      );
    }

    let totalLogicalRelations = 0;
    for (const op of plan.operations as BackfillOperation[]) {
      for (const refs of Object.values(op.relations) as TypedRelationReference[][]) {
        totalLogicalRelations += refs.length;
      }
    }
    if (totalLogicalRelations !== 320) {
      reasons.push(
        `FAIL_LOGICAL_RELATIONS_COUNT: Esperado 320 referências lógicas de relação, obtido ${totalLogicalRelations}.`,
      );
    }

    const cardBillOps = (plan.operations as BackfillOperation[]).filter(
      (o: BackfillOperation) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS',
    );
    if (cardBillOps.length !== 4) {
      reasons.push(`FAIL_RELATION_PATCH_GROUPS: Esperado 4 grupos de patch de fatura, obtido ${cardBillOps.length}.`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Validar todas as EXISTING_PAGE_ID contra o Notion Live (Item 9)
    // ─────────────────────────────────────────────────────────────────────────
    let existingRelationReferences = 0;
    let verifiedExistingRelationReferences = 0;
    let missingExistingRelationReferences = 0;
    let wrongTargetRelationReferences = 0;

    for (const op of plan.operations as BackfillOperation[]) {
      for (const [relProp, refList] of Object.entries(op.relations) as [string, TypedRelationReference[]][]) {
        for (const ref of refList) {
          if (ref.type === 'EXISTING_PAGE_ID') {
            existingRelationReferences++;
            const contractProp = findPropertyContract(op.targetDataSource.envKey, relProp);
            const expectedTargetEnvKey = contractProp?.relationTargetEnvKey;

            if (!expectedTargetEnvKey || !liveTargetBases[expectedTargetEnvKey]) {
              wrongTargetRelationReferences++;
              reasons.push(
                `FAIL_RELATION_TARGET_CONFIG: Propriedade ${relProp} em ${op.targetDataSource.envKey} aponta para base inexistente ${expectedTargetEnvKey}.`,
              );
              continue;
            }

            const targetBase = liveTargetBases[expectedTargetEnvKey];
            const targetPage = targetBase.records.find((r) => r.id === ref.target);

            if (!targetPage || targetPage.archived) {
              missingExistingRelationReferences++;
              reasons.push(
                `FAIL_RELATION_TARGET_MISSING: Página referenciada ${ref.target} em ${expectedTargetEnvKey} não existe ou está arquivada no Notion live.`,
              );
            } else {
              verifiedExistingRelationReferences++;
            }
          }
        }
      }
    }

    if (missingExistingRelationReferences > 0 || wrongTargetRelationReferences > 0) {
      reasons.push(
        `FAIL_EXISTING_RELATIONS: ${missingExistingRelationReferences} páginas de relação ausentes e ${wrongTargetRelationReferences} alvos incorretos detectados.`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Validar Stable Identities antes do Apply (Item 10)
    // ─────────────────────────────────────────────────────────────────────────
    let stableIdentityConflicts = 0;
    let duplicateStableIds = 0;

    const txBase = liveTargetBases['NOTION_DS_TRANSACTIONS'];
    const billsBase = liveTargetBases['NOTION_DS_CARD_BILLS'];

    for (const op of plan.operations) {
      if (op.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS') {
        const matches = txBase.records.filter((r) => r.properties['ID da Fonte'] === op.stableId);
        if (matches.length === 1) {
          stableIdentityConflicts++;
          reasons.push(`PREEXISTING_STABLE_ID: ID da Fonte '${op.stableId}' já existe no Notion live.`);
        } else if (matches.length > 1) {
          duplicateStableIds++;
          reasons.push(`DUPLICATE_STABLE_ID: ID da Fonte '${op.stableId}' duplicado (${matches.length} páginas) no Notion live.`);
        }
      } else if (op.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS') {
        const matches = billsBase.records.filter((r) => r.properties['ID Estável da Fatura'] === op.stableId);
        if (matches.length === 1) {
          stableIdentityConflicts++;
          reasons.push(`PREEXISTING_STABLE_ID: ID Estável da Fatura '${op.stableId}' já existe no Notion live.`);
        } else if (matches.length > 1) {
          duplicateStableIds++;
          reasons.push(
            `DUPLICATE_STABLE_ID: ID Estável da Fatura '${op.stableId}' duplicado (${matches.length} páginas) no Notion live.`,
          );
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Validar Journal de Produção Vazio / Segregado (Item 14)
    // ─────────────────────────────────────────────────────────────────────────
    const journalDir = path.dirname(this.journalPath);
    if (!fs.existsSync(journalDir)) {
      fs.mkdirSync(journalDir, { recursive: true });
    }

    // Testar se o diretório é gravável
    let isDirWritable = false;
    try {
      const probeFile = path.join(journalDir, `.probe-${Date.now()}`);
      fs.writeFileSync(probeFile, 'probe');
      fs.unlinkSync(probeFile);
      isDirWritable = true;
    } catch {
      isDirWritable = false;
      reasons.push(`FAIL_JOURNAL_PATH: Diretório do journal ${journalDir} não possui permissão de escrita.`);
    }

    // Checar se .local/ está no .gitignore
    const gitignorePath = path.resolve(process.cwd(), '.gitignore');
    let isGitIgnored = false;
    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      isGitIgnored = gitignoreContent.includes('.local') || gitignoreContent.includes('.local/');
    }
    if (!isGitIgnored) {
      reasons.push(`FAIL_JOURNAL_SECURITY: O diretório do journal ${journalDir} não está coberto pelo .gitignore.`);
    }

    const journalExists = fs.existsSync(this.journalPath);
    let existingRunsCount: number | undefined = undefined;

    if (journalExists) {
      try {
        const db = new Database(this.journalPath, { readonly: true });
        const row = db.prepare('SELECT count(*) as count FROM sqlite_master WHERE type="table" AND name="backfill_runs"').get() as any;
        if (row?.count > 0) {
          const runCountRow = db.prepare('SELECT count(*) as count FROM backfill_runs').get() as any;
          existingRunsCount = runCountRow?.count ?? 0;
        }
        db.close();
      } catch (err: any) {
        reasons.push(`FAIL_JOURNAL_READ: Não foi possível ler o journal existente em ${this.journalPath}: ${err.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. Mutações Live (Item 2 & 11: devem ser estritamente 0)
    // ─────────────────────────────────────────────────────────────────────────
    const liveMutations = liveAdapter.getMutationCount();
    if (liveMutations !== 0) {
      reasons.push(`FAIL_LIVE_MUTATIONS_DETECTED: Detectadas ${liveMutations} mutações live.`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 11. Conclusão Final e Artefato de Autorização Read-Only (Itens 15, 16, 17, 18)
    // ─────────────────────────────────────────────────────────────────────────
    const readyForLiveApplyReview = reasons.length === 0 && liveMutations === 0;
    const readyForApply = false; // Estritamente false durante toda a Fase 2C

    const artifact: LivePreflightArtifact = {
      preflightVersion: '1.0.0',
      timestamp: generatedAt,
      generatedAt,
      expiresAt,
      ttlMinutes: this.ttlMinutes,
      executorCommitSha,
      executorParentCommitSha,
      planOriginCommitSha: this.planOriginSha,
      backfillPlanHash: plan.backfillPlanHash,
      sourceSnapshotHash: plan.sourceSnapshotHash,
      targetSnapshotHash: plan.targetNotionSnapshotHash,
      frozenTargetStateHash: FROZEN_TARGET_STATE_HASH,
      liveTargetStateHash,
      workspaceIdentityHash,
      actorType,
      schema: {
        total: schemaEvidence.totalDataSources,
        verified: schemaEvidence.verifiedDataSources,
        missing: schemaEvidence.missingPropertiesCount,
        mismatches: schemaEvidence.structuralMismatchesCount,
      },
      targets: {
        transactions: txRowCount,
        bills: billsRowCount,
      },
      stableIdentityConflicts: stableIdentityConflicts + duplicateStableIds,
      relationTargetErrors: missingExistingRelationReferences + wrongTargetRelationReferences,
      liveMutations,
      readyForLiveApplyReview,
      readyForApply,
      reasons,
      rowCountsByDataSource,
      existingRelationsSummary: {
        total: existingRelationReferences,
        verified: verifiedExistingRelationReferences,
        missing: missingExistingRelationReferences,
        wrongTarget: wrongTargetRelationReferences,
      },
      stableIdentitiesSummary: {
        totalChecked: 159,
        conflicts: stableIdentityConflicts,
        duplicates: duplicateStableIds,
      },
      journalStatus: {
        path: this.journalPath,
        exists: journalExists,
        writable: isDirWritable,
        gitIgnored: isGitIgnored,
        existingRunsCount,
      },
      structuralDiff: structuralDiff.length > 0 ? structuralDiff : undefined,
    };

    // Gravação segura e atômica do artefato .local/backfill-live-preflight.json
    const artifactDir = path.dirname(this.artifactPath);
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }
    fs.writeFileSync(this.artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

    return artifact;
  }
}

/**
 * Valida se um artefato de preflight ainda está dentro de sua janela de TTL (Item 16).
 */
export function isPreflightValid(
  artifact: LivePreflightArtifact,
  maxAgeMs: number = 15 * 60 * 1000,
): { valid: boolean; reason?: string } {
  const generatedTime = new Date(artifact.generatedAt).getTime();
  const now = Date.now();
  if (now - generatedTime > maxAgeMs) {
    return { valid: false, reason: 'LIVE_PREFLIGHT_EXPIRED: O preflight expirou (> 15 minutos). Novo preflight read-only exigido.' };
  }
  return { valid: true };
}

/**
 * Valida a integridade criptográfica de binding do artefato contra a baseline congelada (Item 17).
 */
export function validatePreflightBinding(
  artifact: LivePreflightArtifact,
  expected: {
    executorCommitSha?: string;
    planOriginCommitSha?: string;
    backfillPlanHash?: string;
    sourceSnapshotHash?: string;
    targetSnapshotHash?: string;
    targetStateHash?: string;
    workspaceIdentityHash?: string;
  } = {},
): { valid: boolean; reason?: string } {
  const expPlanOrigin = expected.planOriginCommitSha || PLAN_ORIGIN_COMMIT_SHA;
  const expPlanHash = expected.backfillPlanHash || FROZEN_BACKFILL_PLAN_HASH;
  const expSource = expected.sourceSnapshotHash || FROZEN_SOURCE_SNAPSHOT_PLAINTEXT_SHA256;
  const expTarget = expected.targetSnapshotHash || FROZEN_TARGET_SNAPSHOT_PLAINTEXT_SHA256;
  const expState = expected.targetStateHash || FROZEN_TARGET_STATE_HASH;

  if (artifact.planOriginCommitSha !== expPlanOrigin) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: planOriginCommitSha diverge (${artifact.planOriginCommitSha} vs ${expPlanOrigin}).` };
  }
  if (artifact.backfillPlanHash !== expPlanHash) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: backfillPlanHash diverge (${artifact.backfillPlanHash} vs ${expPlanHash}).` };
  }
  if (artifact.sourceSnapshotHash !== expSource) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: sourceSnapshotHash diverge (${artifact.sourceSnapshotHash} vs ${expSource}).` };
  }
  if (artifact.targetSnapshotHash !== expTarget) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: targetSnapshotHash diverge (${artifact.targetSnapshotHash} vs ${expTarget}).` };
  }
  if (artifact.frozenTargetStateHash !== expState) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: frozenTargetStateHash diverge (${artifact.frozenTargetStateHash} vs ${expState}).` };
  }
  if (expected.workspaceIdentityHash && artifact.workspaceIdentityHash !== expected.workspaceIdentityHash) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: workspaceIdentityHash diverge (${artifact.workspaceIdentityHash} vs ${expected.workspaceIdentityHash}).` };
  }
  if (expected.executorCommitSha && artifact.executorCommitSha !== expected.executorCommitSha) {
    return { valid: false, reason: `FAIL_PREFLIGHT_BINDING_MISMATCH: executorCommitSha diverge (${artifact.executorCommitSha} vs ${expected.executorCommitSha}).` };
  }

  return { valid: true };
}
