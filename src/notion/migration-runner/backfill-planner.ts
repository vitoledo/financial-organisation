import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { calculateCanonicalFingerprint } from '../../domain/types';
import {
  BackfillPlan,
  BackfillPipeline,
  BackfillPlanArtifact,
  BackfillOperation,
  TransactionResolutionAudit,
  CardBillAuditItem,
  CategoryReconciliationItem,
  ProposedDerivedUpdateAudit,
  PaymentLegAuditItem,
  IncomingTransferAuditItem,
  CardBillFieldProvenance,
  TypedRelationReference,
  PaymentEventAllocation,
  BackfillSchemaConformanceEvidence,
  BackfillPlannerConfig,
} from './types';

export const DEFAULT_BACKFILL_PLANNER_CONFIG: BackfillPlannerConfig = {
  sourceAccountMapping: {},
  sameOwnershipCategoryKeywords: ['mesma titularidade'],
};

export function buildSemanticPlannerConfig(config: BackfillPlannerConfig): Record<string, any> {
  const sortedSourceMapping: Record<string, 'CHECKING' | 'CREDIT'> = {};
  for (const k of Object.keys(config.sourceAccountMapping || {}).sort()) {
    sortedSourceMapping[k] = config.sourceAccountMapping[k];
  }

  const sortedKeywords = [...(config.sameOwnershipCategoryKeywords || [])].sort();

  const semantic: Record<string, any> = {
    sourceAccountMapping: sortedSourceMapping,
    sameOwnershipCategoryKeywords: sortedKeywords,
    hmacKeyVersion: config.hmacKeyVersion || 'v1',
  };

  if (typeof config.defaultDueDay === 'number') {
    semantic.defaultDueDay = config.defaultDueDay;
  }

  return semantic;
}

export function calculateSemanticConfigHash(config: BackfillPlannerConfig): string {
  const semantic = buildSemanticPlannerConfig(config);
  return crypto.createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

export function validateHmacKey(key?: string): { valid: boolean; reason?: string } {
  if (!key || key.trim().length === 0) {
    return { valid: true };
  }
  const trimmed = key.trim();
  // 64-hex string (32 bytes raw)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return { valid: true };
  }
  // Base64 string that decodes to >= 32 bytes
  if (/^[A-Za-z0-9+/]{42,43}={0,2}$/.test(trimmed) || /^[A-Za-z0-9+/]{44}$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, 'base64');
      if (decoded.length >= 32) return { valid: true };
    } catch {
      // ignore
    }
  }
  return {
    valid: false,
    reason:
      'Chave COUNTERPARTY_HMAC_KEY inválida ou fraca. Exigido material criptográfico forte de no mínimo 32 bytes (64 caracteres hexadecimais ou Base64 de 44 caracteres). Strings curtas ou arbitrárias são estritamente proibidas.',
  };
}

export function generateCounterpartyPseudonym(
  counterpartyName: string,
  hmacKey?: string,
  keyVersion: string = 'v1',
): string {
  if (!counterpartyName || typeof counterpartyName !== 'string') return '[OFUSCADO]';
  if (!hmacKey || hmacKey.trim().length === 0) return '[OFUSCADO]';

  const check = validateHmacKey(hmacKey);
  if (!check.valid) {
    throw new Error(`FAIL_CLOSED_HMAC_KEY: ${check.reason}`);
  }

  const hmacHex = crypto.createHmac('sha256', hmacKey.trim()).update(counterpartyName).digest('hex');
  const truncated = hmacHex.substring(0, 32);
  return `HMAC_${keyVersion}_${truncated}`;
}

export function resolvePlannerConfig(
  userConfig?: BackfillPlannerConfig,
  envVars?: Record<string, string | undefined>,
): {
  effectiveConfig: BackfillPlannerConfig;
  mappingHash: string;
  mappingPath: string;
} {
  const mappingPath =
    userConfig?.accountMappingConfigPath ||
    envVars?.BACKFILL_ACCOUNT_MAPPING_PATH ||
    process.env.BACKFILL_ACCOUNT_MAPPING_PATH ||
    '';

  let sourceAccountMapping: Record<string, 'CHECKING' | 'CREDIT'> = {};
  let mappingHash = '';
  let fileDueDay: number | undefined = undefined;

  if (userConfig?.sourceAccountMapping && Object.keys(userConfig.sourceAccountMapping).length > 0) {
    sourceAccountMapping = { ...userConfig.sourceAccountMapping };
    mappingHash = crypto.createHash('sha256').update(JSON.stringify(sourceAccountMapping)).digest('hex');
  } else if (mappingPath && fs.existsSync(mappingPath)) {
    const raw = fs.readFileSync(mappingPath, 'utf8');
    mappingHash = crypto.createHash('sha256').update(raw).digest('hex');
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.sourceAccountMapping && typeof parsed.sourceAccountMapping === 'object') {
          sourceAccountMapping = { ...parsed.sourceAccountMapping };
          if (typeof parsed.defaultDueDay === 'number') {
            fileDueDay = parsed.defaultDueDay;
          }
        } else {
          const entries = { ...parsed };
          if (typeof entries.defaultDueDay === 'number') {
            fileDueDay = entries.defaultDueDay;
            delete entries.defaultDueDay;
          }
          sourceAccountMapping = entries;
        }
      }
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_ACCOUNT_MAPPING_CONFIG: JSON inválido no arquivo ${mappingPath}: ${err.message}`);
    }
  } else {
    throw new Error(
      `FAIL_CLOSED_ACCOUNT_MAPPING_CONFIG: Arquivo de mapeamento de contas de origem obrigatório não encontrado ou não configurado (${mappingPath || 'BACKFILL_ACCOUNT_MAPPING_PATH ausente'}).`,
    );
  }

  // Validate mapping entries
  for (const [accId, role] of Object.entries(sourceAccountMapping)) {
    if (role !== 'CHECKING' && role !== 'CREDIT') {
      throw new Error(
        `FAIL_CLOSED_ACCOUNT_MAPPING_CONFIG: Papel inválido '${role}' para conta ${accId}. Esperado 'CHECKING' ou 'CREDIT'.`,
      );
    }
  }

  const effectiveDueDay =
    userConfig?.defaultDueDay !== undefined
      ? userConfig.defaultDueDay
      : fileDueDay;

  const rawHmacKey =
    userConfig?.counterpartyHmacKey ||
    envVars?.COUNTERPARTY_HMAC_KEY ||
    process.env.COUNTERPARTY_HMAC_KEY;

  if (rawHmacKey && rawHmacKey.trim().length > 0) {
    const check = validateHmacKey(rawHmacKey);
    if (!check.valid) {
      throw new Error(`FAIL_CLOSED_HMAC_KEY: ${check.reason}`);
    }
  }

  const effectiveConfig: BackfillPlannerConfig = {
    ...DEFAULT_BACKFILL_PLANNER_CONFIG,
    ...(userConfig || {}),
    sourceAccountMapping,
    defaultDueDay: effectiveDueDay,
    accountMappingConfigPath: mappingPath,
    accountMappingConfigHash: mappingHash,
    counterpartyHmacKey: rawHmacKey,
    hmacKeyVersion:
      userConfig?.hmacKeyVersion ||
      envVars?.COUNTERPARTY_HMAC_KEY_VERSION ||
      process.env.COUNTERPARTY_HMAC_KEY_VERSION ||
      'v1',
    sameOwnershipCategoryKeywords:
      userConfig?.sameOwnershipCategoryKeywords ||
      DEFAULT_BACKFILL_PLANNER_CONFIG.sameOwnershipCategoryKeywords,
  };

  return { effectiveConfig, mappingHash, mappingPath };
}

export function getLastDayOfMonth(year: number, month1Indexed: number): number {
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate();
}

export function isValidIsoDate(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const maxDay = getLastDayOfMonth(y, m);
  return d >= 1 && d <= maxDay;
}

export interface BackfillPlanGeneratorOptions {
  dbPath?: string;
  envVars?: Record<string, string | undefined>;
  commitSha?: string;
  sourceSnapshotHash?: string;
  targetNotionSnapshotHash?: string;
  targetStateHash?: string;
  targetLiveDriftZero?: boolean;
  targetSnapshotManifestPath?: string;
  upstreamBillEnrichmentHash?: string;
  plannerConfig?: BackfillPlannerConfig;
  snapshotValidation?: {
    ciphertextIntegrityValid?: boolean;
    manifestIntegrityValid?: boolean;
    manifestStructureAndHashReferencesValid?: boolean;
    plaintextRestoreVerified?: boolean;
    targetStateHash?: string;
    frozenTargetStateHash?: string;
    targetLiveDriftZero?: boolean;
    sourceSnapshotCiphertextValid?: boolean;
    sourceSnapshotManifestValid?: boolean;
    sourceSnapshotRestoreVerified?: boolean;
    sourceSnapshotPlaintextSha256?: string;
    sourceSnapshotEncryptedSha256?: string;
    sourceSnapshotManifestPath?: string;
  };
  notionAccounts?: Array<{ id: string; name: string; type: string }>;
  notionCategories?: Array<{ id: string; name: string; group?: string }>;
  schemaEvidence?: BackfillSchemaConformanceEvidence;
  _isReproducibilityCheck?: boolean;
  _mockExpectedEconomicExpenses?: number;
  _forceIrreproducibleHash?: boolean;
}


/**
 * Validates each operation payload and relations strictly against TARGET_CONTRACT schema.
 * Throws an explicit error if any property name or select option is invalid.
 */
export function validateOperationAgainstContract(
  envKey: string,
  sanitizedPayload: Record<string, any>,
  relations: Record<string, TypedRelationReference[]>,
): void {
  const contract = TARGET_CONTRACT[envKey];
  if (!contract) {
    throw new Error(`CONTRACT_VALIDATION_ERROR: Data source '${envKey}' não encontrada em TARGET_CONTRACT.`);
  }

  // Build property lookup index supporting canonical names and declared aliases
  const propertyIndex = new Map<string, any>();
  for (const prop of contract.properties) {
    propertyIndex.set(prop.notionProperty, prop);
    if (prop.aliases) {
      for (const alias of prop.aliases) {
        propertyIndex.set(alias, prop);
      }
    }
  }

  // 1. Validate primitive payload properties
  for (const [key, value] of Object.entries(sanitizedPayload)) {
    const propContract = propertyIndex.get(key);
    if (!propContract) {
      throw new Error(
        `CONTRACT_VALIDATION_ERROR: Propriedade '${key}' não permitida pelo contrato de ${envKey} (${contract.defaultTitle}).`,
      );
    }

    // If property is a select, validate option value against contract
    if (propContract.notionType === 'select' && value !== null && value !== undefined) {
      const allowedOptions = propContract.expectedOptions || [];
      if (allowedOptions.length > 0 && !allowedOptions.includes(value)) {
        throw new Error(
          `CONTRACT_VALIDATION_ERROR: Opção '${value}' inválida para select '${key}' em ${envKey}. Opções permitidas: [${allowedOptions.join(', ')}]`,
        );
      }
    }
  }

  // 2. Validate relation properties
  for (const [relKey, relRefs] of Object.entries(relations)) {
    const propContract = propertyIndex.get(relKey);
    if (!propContract) {
      throw new Error(
        `CONTRACT_VALIDATION_ERROR: Relação '${relKey}' não permitida pelo contrato de ${envKey} (${contract.defaultTitle}).`,
      );
    }
    if (propContract.notionType !== 'relation') {
      throw new Error(
        `CONTRACT_VALIDATION_ERROR: Propriedade '${relKey}' em ${envKey} não é do tipo 'relation' (tipo: ${propContract.notionType}).`,
      );
    }
    for (const ref of relRefs) {
      if (!ref.type || (ref.type !== 'EXISTING_PAGE_ID' && ref.type !== 'PLANNED_STABLE_ID')) {
        throw new Error(
          `CONTRACT_VALIDATION_ERROR: Relação '${relKey}' possui referência sem tipo canônico ('EXISTING_PAGE_ID' | 'PLANNED_STABLE_ID'): ${JSON.stringify(ref)}`,
        );
      }
      if (!ref.target || typeof ref.target !== 'string' || ref.target.trim().length === 0) {
        throw new Error(
          `CONTRACT_VALIDATION_ERROR: Relação '${relKey}' possui target vazio ou inválido: ${JSON.stringify(ref)}`,
        );
      }
    }
  }
}

export class BackfillPlanner {
  private envVars: Record<string, string | undefined>;
  private dbPath: string;

  constructor(options: { dbPath?: string; envVars?: Record<string, string | undefined> } = {}) {
    this.envVars = options.envVars ?? (process.env as Record<string, string | undefined>);
    this.dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'financial.db');
  }

  /**
   * Phase 1 Schema Runner compatibility: generates high-level backfill pipeline description.
   */
  public generatePlan(): BackfillPlan {
    const pipelines: BackfillPipeline[] = [
      {
        id: 'PIPELINE_1_ACCOUNTS',
        name: 'Backfill de Contas e Limites Operacionais',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_ACCOUNTS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_ACCOUNTS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Popula Limite Operacional Usado (Limite Personalizado - Limite Disponível), Limite Usado da Fonte (Bruto) e Dia de Fechamento.',
        readStrategy:
          'Cursor-based paged query de todas as contas ativas no Notion; leitura comparativa dos metadados locais no SQLite.',
        transformStrategy:
          'Cálculo determinístico: limiteOperacionalUsado = max(0, limitePersonalizado - limiteDisponivel). Atribuição de diaDeFechamento para contas de cartão.',
        writeStrategy:
          'PATCH idempotente por registro com rate-limiting de 3 req/s; gravação de checkpoint no SQLite a cada página de 50 registros.',
        verificationStrategy:
          'Reconciliação 1:1 entre os saldos e limites do Notion e as entidades armazenadas no SQLite.',
        dependencies: [],
      },
      {
        id: 'PIPELINE_2_TRANSACTIONS',
        name: 'Backfill de Transações (Classificação Canônica e Efeitos Orçamentários)',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_TRANSACTIONS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_TRANSACTIONS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Popula Natureza Econômica, Efeito Orçamentário (INCOME | EXPENSE | REVERSAL | NEUTRAL), Propósito de Alocação e Contribuição Meta Poupança.',
        readStrategy:
          'Cursor paged query filtrando transações com Natureza Econômica nula ou não classificada.',
        transformStrategy:
          'Aplicação das regras de classificação: mapeamento para Natureza Econômica (Receita, Despesa, Aporte, Resgate, Transferência interna, Reembolso, Pagamento de fatura, Ajuste), definição do Efeito Orçamentário estritamente entre INCOME, EXPENSE, REVERSAL ou NEUTRAL, definição de Propósito de Alocação (Caixa Operacional, Reserva de Investimento, Reserva de Emergência, Poupança Geral) e atribuição de Contribuição Meta Poupança exclusivamente quando houver aporte novo à poupança (despesas subsequentes com recursos poupados = 0).',
        writeStrategy:
          'PATCH idempotente em lotes controlados com throttle, salvando o último ID processado na tabela local de checkpoints.',
        verificationStrategy:
          'Soma de verificação (checksum) dos totais por natureza, contagem de transações classificadas vs. pendentes, conferência de ausência de campos nulos em registros confirmados.',
        dependencies: ['PIPELINE_1_ACCOUNTS'],
      },
      {
        id: 'PIPELINE_3_MONTHLY_BUDGET',
        name: 'Backfill e Reconciliação do Planejamento Mensal',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_MONTHLY_BUDGET.envKey,
          name: TARGET_CONTRACT.NOTION_DS_MONTHLY_BUDGET.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Agrega e totaliza Receitas Realizadas, Despesas Realizadas, Poupança Realizada (via Contribuição Meta Poupança) e Compras Realizadas Cartão.',
        readStrategy:
          'Leitura dos registros de Planejamento Mensal existentes no Notion indexados pelo mês de referência.',
        transformStrategy:
          'Agregação a partir das transações migradas no SQLite: soma de transações com Efeito Orçamentário INCOME (Receitas Realizadas), soma com EXPENSE (Despesas Realizadas), soma estrita de savingsGoalContribution (Poupança Realizada), e soma de transações de contas de crédito no período.',
        writeStrategy:
          'PATCH idempotente por mês orçamentário atualizando os valores agregados arredondados em duas casas decimais.',
        verificationStrategy:
          'A soma dos valores realizados no Notion deve ser idêntica ao total apurado na agregação das transações no SQLite.',
        dependencies: ['PIPELINE_2_TRANSACTIONS'],
      },
      {
        id: 'PIPELINE_4_MONTHLY_OBLIGATIONS',
        name: 'Backfill de Obrigações Mensais e Vínculos',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_MONTHLY_OBLIGATIONS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_MONTHLY_OBLIGATIONS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Padronização do Status (select) para o conjunto homologado de 7 opções, vinculação com Conta de Pagamento e identificador externo.',
        readStrategy:
          'Leitura completa das obrigações mensais do exercício atual.',
        transformStrategy:
          'Mapeamento de status: preservação de Prevista, Pendente, Paga, Atrasada, Dispensada; classificação de inconsistências como Revisão Necessária e obrigações descartadas como Cancelada. Vinculação com a conta bancária padrão configurada.',
        writeStrategy:
          'PATCH idempotente apenas nos registros cujos campos novos ou status divergirem do esperado.',
        verificationStrategy:
          'Verificação de que 100% das obrigações possuem status válido pertencente ao conjunto homologado de 7 opções.',
        dependencies: ['PIPELINE_1_ACCOUNTS'],
      },
      {
        id: 'PIPELINE_5_CARD_BILLS',
        name: 'Geração e Vinculação de Ciclos de Fatura',
        targetDataSource: {
          envKey: TARGET_CONTRACT.NOTION_DS_CARD_BILLS.envKey,
          name: TARGET_CONTRACT.NOTION_DS_CARD_BILLS.defaultTitle,
        },
        mode: 'IDEMPOTENT_CHECKPOINTED',
        description:
          'Criação das instâncias de Fatura / Ciclo na 13ª base e vinculação dual com Transações via Lançamentos do Ciclo <-> Fatura Vinculada.',
        readStrategy:
          'Agrupamento das transações de cartão por conta e intervalo de datas de corte a partir da base local.',
        transformStrategy:
          'Determinação de identidade da fatura: se bill_id da fonte disponível, Qualidade da Identidade = SOURCE_ID; caso contrário, Qualidade da Identidade = PERIOD_FALLBACK com formato exato source:account:periodStart:periodEnd:currency. Atribuição de Status da Fatura estritamente conforme enums homologados (Aberta em Curso, Fechada a Vencer, Vencida, Paga Integralmente, Paga Parcialmente). Totalização de Valor da Fatura Fechada (Oficial) ou Valor Estimado da Fatura Aberta e Total de Compras no Ciclo.',
        writeStrategy:
          'POST de novos registros na base Faturas / Ciclos de Cartão, seguido de PATCH nas transações correspondentes para vincular a dual relation Fatura Vinculada.',
        verificationStrategy:
          'Soma das transações associadas a cada ciclo deve bater com precisão centesimal com o total de compras apurado no ciclo.',
        dependencies: ['PIPELINE_2_TRANSACTIONS'],
      },
    ];

    return {
      version: '1.0.0',
      totalPipelines: pipelines.length,
      pipelines,
    };
  }

  public generateArtifact(options: BackfillPlanGeneratorOptions = {}): {
    artifact: BackfillPlanArtifact;
    transactionAudits: TransactionResolutionAudit[];
    cardBillAudits: CardBillAuditItem[];
    categoryReconciliations: CategoryReconciliationItem[];
    proposedDerivedUpdates: ProposedDerivedUpdateAudit[];
    paymentLegAudits: PaymentLegAuditItem[];
    incomingTransferAudits: IncomingTransferAuditItem[];
    paymentEventAllocations: PaymentEventAllocation[];
  } {
    const generatedAt = new Date().toISOString();
    const mappingVersion = '2.2.0-phase2a.2-hardened';

    // 1. Commit SHA (FAIL-CLOSED: NO SILENT FALLBACK)
    let commitSha = options.commitSha;
    if (!commitSha) {
      try {
        commitSha = execSync('git rev-parse HEAD', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch (err: any) {
        throw new Error(
          `FAIL_CLOSED_GIT_RESOLUTION: Falha ao executar 'git rev-parse HEAD': ${err?.message || err}. Não é permitido gerar plano de backfill sem identidade Git estrita.`,
        );
      }
    }

    if (!commitSha || !/^[a-f0-9]{40}$/i.test(commitSha)) {
      throw new Error(
        `FAIL_CLOSED_GIT_RESOLUTION: Commit SHA inválido ou malformatado ('${commitSha}'). Esperado hash SHA-1 de 40 caracteres.`,
      );
    }

    // 2. Source Snapshot Binding (SQLite DB)
    const effectiveDbPath = options.dbPath || this.dbPath;
    if (!fs.existsSync(effectiveDbPath)) {
      throw new Error(`FAIL_CLOSED_SOURCE_DB: Arquivo de banco de dados SQLite não encontrado em '${effectiveDbPath}'.`);
    }
    const dbBuf = fs.readFileSync(effectiveDbPath);
    const calculatedHashOfDbActuallyConsumed = crypto.createHash('sha256').update(dbBuf).digest('hex');

    if (options.snapshotValidation?.sourceSnapshotPlaintextSha256) {
      if (calculatedHashOfDbActuallyConsumed !== options.snapshotValidation.sourceSnapshotPlaintextSha256) {
        throw new Error(
          `FAIL_CLOSED_SOURCE_SNAPSHOT_BINDING: Hash do banco SQLite efetivamente consumido (${calculatedHashOfDbActuallyConsumed}) diverge do hash do snapshot homologado (${options.snapshotValidation.sourceSnapshotPlaintextSha256}).`,
        );
      }
    }

    if (options.sourceSnapshotHash && options.sourceSnapshotHash !== calculatedHashOfDbActuallyConsumed) {
      throw new Error(
        `FAIL_CLOSED_SOURCE_DB: Hash do banco SQLite (${calculatedHashOfDbActuallyConsumed}) diverge do hash esperado (${options.sourceSnapshotHash}).`,
      );
    }
    const sourceSnapshotHash = calculatedHashOfDbActuallyConsumed;

    // 3. Target Notion Snapshot Binding (Explicit Manifest Binding - FAIL-CLOSED)
    const targetManifestPath = options.targetSnapshotManifestPath ?? this.envVars.NOTION_TARGET_SNAPSHOT_MANIFEST?.trim();
    if (!targetManifestPath) {
      throw new Error(
        'FAIL_CLOSED_TARGET_SNAPSHOT: Caminho do manifesto do snapshot alvo não informado nem configurado em NOTION_TARGET_SNAPSHOT_MANIFEST.',
      );
    }

    if (!fs.existsSync(targetManifestPath)) {
      throw new Error(`FAIL_CLOSED_TARGET_SNAPSHOT: Manifesto do snapshot alvo não encontrado em '${targetManifestPath}'.`);
    }

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(targetManifestPath, 'utf8'));
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_TARGET_SNAPSHOT: Erro ao ler manifesto de snapshot alvo: ${err.message}`);
    }

    const encFilePath = path.join(path.dirname(targetManifestPath), manifest.backupFileName);
    if (!fs.existsSync(encFilePath)) {
      throw new Error(
        `FAIL_CLOSED_TARGET_SNAPSHOT: Arquivo criptografado de snapshot '${encFilePath}' referenciado no manifesto não existe.`,
      );
    }
    const encBuf = fs.readFileSync(encFilePath);
    const actualEncSha = crypto.createHash('sha256').update(encBuf).digest('hex');
    if (actualEncSha !== manifest.encryptedFileSha256) {
      throw new Error(
        `CORRUPTED_SNAPSHOT: Hash do arquivo criptografado (${actualEncSha}) diverge do manifesto (${manifest.encryptedFileSha256}).`,
      );
    }
    const targetNotionSnapshotHash = manifest.originalJsonSha256;
    if (options.targetNotionSnapshotHash && options.targetNotionSnapshotHash !== targetNotionSnapshotHash) {
      throw new Error(
        `CORRUPTED_SNAPSHOT: Hash original do snapshot fornecido nas opções (${options.targetNotionSnapshotHash}) diverge do manifesto (${targetNotionSnapshotHash}).`,
      );
    }
    const targetStateHash =
      options.targetStateHash ??
      options.snapshotValidation?.targetStateHash ??
      options.snapshotValidation?.frozenTargetStateHash ??
      '';

    // 4. Data Source IDs (FAIL-CLOSED: NO SILENT FALLBACKS)
    const accountsDsId = this.envVars.NOTION_DS_ACCOUNTS?.trim();
    if (!accountsDsId) {
      throw new Error('FAIL_CLOSED_ENV: Variável NOTION_DS_ACCOUNTS não configurada.');
    }
    const categoriesDsId = this.envVars.NOTION_DS_CATEGORIES?.trim();
    if (!categoriesDsId) {
      throw new Error('FAIL_CLOSED_ENV: Variável NOTION_DS_CATEGORIES não configurada.');
    }
    const transactionsDsId = this.envVars.NOTION_DS_TRANSACTIONS?.trim();
    if (!transactionsDsId) {
      throw new Error('FAIL_CLOSED_ENV: Variável NOTION_DS_TRANSACTIONS não configurada.');
    }
    const cardBillsDsId = this.envVars.NOTION_DS_CARD_BILLS?.trim();
    if (!cardBillsDsId) {
      throw new Error('FAIL_CLOSED_ENV: Variável NOTION_DS_CARD_BILLS não configurada.');
    }

    // 5. Notion Accounts & Categories (FAIL-CLOSED: NO SILENT HARDCODED FIXTURES)
    const notionAccounts = options.notionAccounts;
    if (!notionAccounts || notionAccounts.length === 0) {
      throw new Error(
        'FAIL_CLOSED_NOTION_METADATA: Lista de contas do Notion Live não foi informada. Abortando sem fixtures silenciosas.',
      );
    }

    const notionCategories = options.notionCategories;
    if (!notionCategories || notionCategories.length === 0) {
      throw new Error(
        'FAIL_CLOSED_NOTION_METADATA: Lista de categorias do Notion Live não foi informada. Abortando sem fixtures silenciosas.',
      );
    }

    const categoryIdByName = new Map<string, string>();
    for (const cat of notionCategories) {
      categoryIdByName.set(cat.name.toLowerCase().trim(), cat.id);
    }

    // 6. SQLite Source Data Extraction & Account Resolution Table
    const db = new Database(effectiveDbPath, { readonly: true });
    const sqliteAccounts = db.prepare('SELECT * FROM accounts').all() as any[];
    const sqliteTransactions = db.prepare('SELECT * FROM transactions ORDER BY date ASC, id ASC').all() as any[];
    db.close();

    const accountLookupTable = new Map<
      string,
      {
        notionPageId: string;
        notionAccountName: string;
        sourceType: string;
        sourceSubtype: string;
      }
    >();

    const nubankCartaoPage = notionAccounts.find((a) => a.name === 'Nubank Cartão');
    const nubankContaPage = notionAccounts.find((a) => a.name === 'Nubank Conta');

    if (!nubankCartaoPage || !nubankContaPage) {
      throw new Error(
        'FAIL_CLOSED_ACCOUNT_MAPPING: Páginas canônicas de conta (Nubank Cartão / Nubank Conta) ausentes no Notion Live.',
      );
    }

    const { effectiveConfig, mappingHash, mappingPath } = resolvePlannerConfig(
      options.plannerConfig,
      options.envVars || this.envVars,
    );

    for (const acc of sqliteAccounts) {
      const mappedRole = effectiveConfig.sourceAccountMapping[acc.id];
      if (mappedRole === 'CHECKING' && acc.type === 'BANK') {
        accountLookupTable.set(acc.id, {
          notionPageId: nubankContaPage.id,
          notionAccountName: nubankContaPage.name,
          sourceType: acc.type,
          sourceSubtype: acc.subtype,
        });
      } else if (mappedRole === 'CREDIT' && acc.type === 'CREDIT') {
        accountLookupTable.set(acc.id, {
          notionPageId: nubankCartaoPage.id,
          notionAccountName: nubankCartaoPage.name,
          sourceType: acc.type,
          sourceSubtype: acc.subtype,
        });
      }
    }

    // 7. Homologated Category Reconciliation Table (zero silent default)
    // Note: Third-party transfers ('(transferência) || transferências') are strictly excluded from
    // 'Transferências internas' to avoid unproved classification; they remain pending review.
    const categoryMappingTable: Record<string, { canonical: string; method: string }> = {
      '(transferência) || pagamento de cartão de crédito': { canonical: 'Transferências internas', method: 'DEBT_SETTLEMENT_RULE' },
      '(transferência) || transferência mesma titularidade': { canonical: 'Transferências internas', method: 'SAME_OWNERSHIP_RULE' },
      'contas e utilidades || internet': { canonical: 'Moradia', method: 'UTILITY_EXPENSE_RULE' },
      'presentes/doações || doações': { canonical: 'Presentes e doações', method: 'DONATION_EXPENSE_RULE' },
      'serviços automotivos || serviços automotivos': { canonical: 'Transporte', method: 'VEHICLE_EXPENSE_RULE' },
      'serviços || serviços': { canonical: 'Serviços e assinaturas', method: 'SERVICE_SUBSCRIPTION_RULE' },
      'compras || compras': { canonical: 'Compras', method: 'DIRECT_CANONICAL_NAME' },
      'moradia || moradia': { canonical: 'Moradia', method: 'DIRECT_CANONICAL_NAME' },
      'transporte || postos de gasolina': { canonical: 'Transporte', method: 'FUEL_TRANSPORT_RULE' },
      'transporte || táxi e transporte privado urbano': { canonical: 'Transporte', method: 'URBAN_RIDE_TRANSPORT_RULE' },
      'alimentos e bebidas || alimentos e bebidas': { canonical: 'Alimentação', method: 'FOOD_BEVERAGE_RULE' },
      'outros || outros': { canonical: 'Outros', method: 'DIRECT_CANONICAL_NAME' },
      'vestuário || vestuário': { canonical: 'Compras', method: 'APPAREL_TO_SHOPPING_RULE' },
      'alimentação || supermercado': { canonical: 'Alimentação', method: 'GROCERY_FOOD_RULE' },
      'saúde || bem-estar': { canonical: 'Saúde', method: 'HEALTH_WELLNESS_RULE' },
      'impostos sobre operações financeiras || impostos sobre operações financeiras': { canonical: 'Impostos e taxas', method: 'TAX_CHARGE_RULE' },
      'serviços digitais || serviços digitais': { canonical: 'Serviços e assinaturas', method: 'DIGITAL_SERVICES_RULE' },
    };

    const categoryAuditMap = new Map<string, { count: number; sum: number; canonical: string; method: string }>();

    // 8. Dynamic Card Bill Cycles Derivation (ZERO hardcoded dataset UUIDs or dates)
    const cardBillCycles: Record<
      string,
      {
        title: string;
        stableBillId: string;
        sourceBillId: string;
        cartao: string;
        inicio: string;
        fim: string;
        fechamento: string;
        vencimento: string | null;
        dataLiquidacao: string | null;
        status: string | null;
        origem: string;
        qualidade: string;
        tipoCiclo: string;
        purchases: any[];
        payments: string[];
        fieldProvenance: CardBillFieldProvenance;
      }
    > = {};

    // Group credit transactions by upstream billId or by month period
    const creditTxs = sqliteTransactions.filter((t) => t.account_type === 'CREDIT');
    const upstreamBillIds = new Set<string>();
    const periodMonths = new Set<string>();

    for (const tx of creditTxs) {
      const raw = JSON.parse(tx.raw_json || '{}');
      const bId = raw.credit_card_data?.billId;
      const isPurchase =
        Number(tx.amount) < 0 &&
        !tx.description.toLowerCase().includes('pagamento') &&
        (!tx.category_pierre || !tx.category_pierre.toLowerCase().includes('pagamento'));

      if (bId && typeof bId === 'string' && bId.trim().length > 0) {
        upstreamBillIds.add(bId.trim());
      } else if (isPurchase) {
        // Fallback cycle ONLY exists if there is at least one purchase without billId in that month
        periodMonths.add(tx.date.substring(0, 7));
      }
    }

    // Build cycles for upstream bills
    for (const bId of upstreamBillIds) {
      const txsInBill = creditTxs.filter((t) => {
        const raw = JSON.parse(t.raw_json || '{}');
        return raw.credit_card_data?.billId === bId;
      });
      const purchases = txsInBill.filter(
        (t) =>
          Number(t.amount) < 0 &&
          !t.description.toLowerCase().includes('pagamento') &&
          (!t.category_pierre || !t.category_pierre.toLowerCase().includes('pagamento')),
      );
      const sortedTxs = [...txsInBill].sort((a, b) => a.date.localeCompare(b.date));
      const minDate = (purchases[0] || sortedTxs[0])?.date.substring(0, 10);
      const maxDate = (purchases[purchases.length - 1] || sortedTxs[sortedTxs.length - 1])?.date.substring(0, 10);
      const month = maxDate.substring(0, 7);

      // Precedence for Due Date:
      // 1. Upstream metadata of the invoice itself
      let vencimento: string | null = null;
      let dueDateProvenance: 'SOURCE' | 'CONFIGURED' | 'DERIVED' | null = null;

      for (const t of txsInBill) {
        const raw = JSON.parse(t.raw_json || '{}');
        const bDueDate = raw.bill_due_date || raw.credit_card_data?.bill_due_date;
        if (bDueDate && typeof bDueDate === 'string' && isValidIsoDate(bDueDate.substring(0, 10))) {
          vencimento = bDueDate.substring(0, 10);
          dueDateProvenance = 'SOURCE';
          break;
        }
      }

      // 2. Card account metadata (balanceDueDate day)
      if (!vencimento) {
        let accountDueDay: number | null = null;
        for (const t of txsInBill) {
          const raw = JSON.parse(t.raw_json || '{}');
          const accDue = raw.account_credit_data?.balanceDueDate;
          if (accDue && typeof accDue === 'string' && isValidIsoDate(accDue.substring(0, 10))) {
            accountDueDay = Number(accDue.substring(8, 10));
            dueDateProvenance = 'SOURCE';
            break;
          }
        }
        if (accountDueDay === null) {
          if (typeof effectiveConfig.defaultDueDay === 'number') {
            accountDueDay = effectiveConfig.defaultDueDay;
            dueDateProvenance = 'CONFIGURED';
          } else {
            dueDateProvenance = null;
          }
        }

        if (accountDueDay !== null) {
          const [yStr, mStr] = month.split('-');
          let dueYear = Number(yStr);
          let dueMonthNum = Number(mStr) + 1;
          if (dueMonthNum > 12) {
            dueMonthNum = 1;
            dueYear += 1;
          }
          const maxDayInDueMonth = getLastDayOfMonth(dueYear, dueMonthNum);
          const safeDueDay = Math.min(accountDueDay, maxDayInDueMonth);
          const dueMonthPadded = dueMonthNum.toString().padStart(2, '0');
          const dueDayPadded = safeDueDay.toString().padStart(2, '0');
          vencimento = `${dueYear}-${dueMonthPadded}-${dueDayPadded}`;
        } else {
          vencimento = null;
        }
      }

      if (!isValidIsoDate(minDate) || !isValidIsoDate(maxDate) || (vencimento !== null && !isValidIsoDate(vencimento))) {
        throw new Error(`FAIL_CLOSED_DATE_VALIDATION: Datas inválidas detectadas para fatura upstream ${bId}`);
      }

      let title: string;
      if (vencimento !== null) {
        const dueDayFormatted = vencimento.substring(8, 10);
        const dueMonthFormatted = vencimento.substring(5, 7);
        title = `${nubankCartaoPage.name} - Ciclo ${month} (Venc ${dueDayFormatted}/${dueMonthFormatted})`;
      } else {
        title = `${nubankCartaoPage.name} - Ciclo ${month}`;
      }

      cardBillCycles[`BILL_${bId}`] = {
        title,
        stableBillId: `nubank:bill:${bId}`,
        sourceBillId: bId,
        cartao: nubankCartaoPage.name,
        inicio: minDate,
        fim: maxDate,
        fechamento: maxDate,
        vencimento,
        dataLiquidacao: null, // dynamically computed upon payment allocation
        status: null, // null when official bill statement is absent
        origem: 'UPSTREAM_BILL_ID',
        qualidade: 'UPSTREAM_APPROXIMATE',
        tipoCiclo: 'Ciclo Real Banco',
        purchases: [],
        payments: [],
        fieldProvenance: {
          title: 'DERIVED',
          source: 'SOURCE',
          sourceBillId: 'SOURCE',
          stableBillId: 'DERIVED',
          identityQuality: 'SOURCE',
          cycleType: 'SOURCE',
          valueQuality: 'DERIVED',
          status: null,
          periodStart: 'DERIVED',
          periodEnd: 'DERIVED',
          closingDate: 'DERIVED',
          dueDate: dueDateProvenance,
          settlementDate: null,
          officialAmount: null,
          estimatedAmount: null,
          purchasesTotal: 'DERIVED',
          paidAmount: 'DERIVED',
        },
      };
    }

    // Build cycles for period months (sorted chronologically)
    const sortedPeriodMonths = Array.from(periodMonths).sort();
    for (const month of sortedPeriodMonths) {
      const txsInMonth = creditTxs.filter((t) => {
        const raw = JSON.parse(t.raw_json || '{}');
        return !raw.credit_card_data?.billId && t.date.startsWith(month);
      });
      const purchases = txsInMonth.filter(
        (t) =>
          Number(t.amount) < 0 &&
          !t.description.toLowerCase().includes('pagamento') &&
          (!t.category_pierre || !t.category_pierre.toLowerCase().includes('pagamento')),
      );
      const sortedPurchases = [...purchases].sort((a, b) => a.date.localeCompare(b.date));
      const sortedTxs = [...txsInMonth].sort((a, b) => a.date.localeCompare(b.date));

      let minDate: string;
      let maxDate: string;
      let fechamento: string;
      if (sortedPurchases.length > 0) {
        minDate = sortedPurchases[0].date.substring(0, 10);
        maxDate = sortedPurchases[sortedPurchases.length - 1].date.substring(0, 10);
        const [yStr, mStr] = month.split('-');
        const lastDay = getLastDayOfMonth(Number(yStr), Number(mStr));
        fechamento = `${month}-${String(lastDay).padStart(2, '0')}`;
      } else {
        minDate = `${month}-01`;
        const [yStr, mStr] = month.split('-');
        const lastDay = getLastDayOfMonth(Number(yStr), Number(mStr));
        maxDate = `${month}-${String(lastDay).padStart(2, '0')}`;
        fechamento = maxDate;
      }

      let vencimento: string | null = null;
      let dueDateProvenance: 'CONFIGURED' | null = null;
      let title: string;

      if (typeof effectiveConfig.defaultDueDay === 'number') {
        const [yearStr, monthStr] = month.split('-');
        let dueYear = Number(yearStr);
        let dueMonthNum = Number(monthStr) + 1;
        if (dueMonthNum > 12) {
          dueMonthNum = 1;
          dueYear += 1;
        }
        const dueDay = effectiveConfig.defaultDueDay;
        const maxDayInDueMonth = getLastDayOfMonth(dueYear, dueMonthNum);
        const safeDueDay = Math.min(dueDay, maxDayInDueMonth);
        const dueMonthPadded = dueMonthNum.toString().padStart(2, '0');
        const dueDayPadded = safeDueDay.toString().padStart(2, '0');
        vencimento = `${dueYear}-${dueMonthPadded}-${dueDayPadded}`;
        dueDateProvenance = 'CONFIGURED';
        title = `${nubankCartaoPage.name} - Ciclo ${month} Aberto (Venc ${dueDayPadded}/${dueMonthPadded})`;
      } else {
        vencimento = null;
        dueDateProvenance = null;
        title = `${nubankCartaoPage.name} - Ciclo ${month} Aberto`;
      }

      if (!isValidIsoDate(minDate) || !isValidIsoDate(maxDate) || !isValidIsoDate(fechamento) || (vencimento !== null && !isValidIsoDate(vencimento))) {
        throw new Error(`FAIL_CLOSED_DATE_VALIDATION: Datas inválidas detectadas para ciclo de período ${month}`);
      }

      cardBillCycles[`PERIOD_${month}`] = {
        title,
        stableBillId: `nubank:cartao:${month}:cycle`,
        sourceBillId: '',
        cartao: nubankCartaoPage.name,
        inicio: minDate,
        fim: maxDate,
        fechamento,
        vencimento,
        dataLiquidacao: null,
        status: null, // null when official bill statement is absent
        origem: 'PERIOD_ESTIMATED',
        qualidade: 'DERIVED',
        tipoCiclo: 'Ciclo Estimado',
        purchases: [],
        payments: [],
        fieldProvenance: {
          title: 'DERIVED',
          source: 'CONFIGURED',
          sourceBillId: 'CONFIGURED',
          stableBillId: 'DERIVED',
          identityQuality: 'CONFIGURED',
          cycleType: 'CONFIGURED',
          valueQuality: 'DERIVED',
          status: null,
          periodStart: 'DERIVED',
          periodEnd: 'DERIVED',
          closingDate: 'DERIVED',
          dueDate: dueDateProvenance,
          settlementDate: null,
          officialAmount: null,
          estimatedAmount: null,
          purchasesTotal: 'DERIVED',
          paidAmount: 'DERIVED',
        },
      };
    }

    // 9. Transaction Processing & Auditing
    const operations: BackfillOperation[] = [];
    const transactionAudits: TransactionResolutionAudit[] = [];
    const incomingTransferAudits: IncomingTransferAuditItem[] = [];

    let unresolvedAccountsCount = 0;
    let unresolvedCategoryErrorsCount = 0;
    let pendingCategoryReviewCount = 0;
    let confirmedDirectCheckingExpenses = 0;
    let pendingThirdPartyOutflows = 0;
    let sameOwnershipOutgoingTransfers = 0;
    let cardBillSettlementCashOutflows = 0;
    let allCheckingOutflowsSum = 0;

    for (const tx of sqliteTransactions) {
      const raw = JSON.parse(tx.raw_json || '{}');
      const amount = Number(tx.amount);
      const isCredit = tx.account_type === 'CREDIT';
      const isPayment =
        tx.description.toLowerCase().includes('pagamento') ||
        (tx.category_pierre && tx.category_pierre.toLowerCase().includes('pagamento'));

      // 9.1. SOURCE_ACCOUNT_ID Resolution
      const accountLookup = accountLookupTable.get(tx.account_id);
      let resolvedAccountName = '';
      let resolvedAccountPageId = '';
      let resolutionMethod: any = 'UNRESOLVED';
      let confidenceStatus: any = 'UNRESOLVED';

      if (accountLookup) {
        resolvedAccountName = accountLookup.notionAccountName;
        resolvedAccountPageId = accountLookup.notionPageId;
        resolutionMethod = 'SOURCE_ACCOUNT_ID';
        confidenceStatus = 'VERY_HIGH';
      } else {
        unresolvedAccountsCount++;
      }

      transactionAudits.push({
        sourceTransactionId: tx.id,
        date: tx.date,
        amount,
        sanitizedDescription: tx.description.trim(),
        flowDirection: amount > 0 ? 'Entrada' : 'Saída',
        originalAccountId: tx.account_id,
        resolvedAccountName,
        resolvedAccountPageId,
        resolutionMethod,
        confidenceStatus,
      });

      // 9.2. Economic Nature, Budget Effect, and Review Status Audit
      const desc = tx.description.trim();
      const descLower = desc.toLowerCase();
      const pierreLower = (tx.category_pierre || '').toLowerCase().trim();
      const mappedLower = (tx.category_mapped || '').toLowerCase().trim();
      const rawCatLower = ((raw.category as string) || '').toLowerCase().trim();
      const lookupKey = `${mappedLower} || ${pierreLower}`;
      const catMapping = categoryMappingTable[lookupKey];

      const isSameOwnership =
        pierreLower.includes('mesma titularidade') ||
        rawCatLower.includes('mesma titularidade') ||
        (effectiveConfig.sameOwnershipCategoryKeywords || []).some(
          (k) => pierreLower.includes(k) || rawCatLower.includes(k),
        );

      const counterpartyName = desc.includes('|') ? desc.split('|')[1].trim() : desc;

      let economicNature: string | null = null;
      let budgetEffect: string | null = null;
      let reviewStatus: 'Confirmado Auto' | 'Pendente Revisão' = 'Confirmado Auto';
      let reviewReason: string | null = null;
      let categoryPageId = '';

      if (tx.account_type === 'BANK' && amount < 0) {
        allCheckingOutflowsSum += Math.abs(amount);
      }

      // 6 Mutually Exclusive Branches:
      // Branch 1: Third-party incoming transfer
      if (amount > 0 && !isSameOwnership) {
        economicNature = null;
        budgetEffect = null;
        reviewStatus = 'Pendente Revisão';
        reviewReason =
          'Transferência recebida de terceiro pendente de classificação econômica definitiva e comprovação documental';
        categoryPageId = '';

        incomingTransferAudits.push({
          txId: tx.id,
          date: tx.date,
          amount,
          description: desc,
          counterpartyName,
          counterpartyType: 'THIRD_PARTY_TRANSFER',
          economicNature: null,
          budgetEffect: null,
          reviewStatus: 'Pendente Revisão',
          reviewReason,
          hasDocumentaryProof: false,
        });
      // Branch 2: Same-ownership incoming transfer
      } else if (amount > 0 && isSameOwnership) {
        economicNature = 'Transferência interna';
        budgetEffect = 'Neutro';
        reviewStatus = 'Confirmado Auto';
        reviewReason = null;
        if (catMapping) {
          categoryPageId = categoryIdByName.get(catMapping.canonical.toLowerCase().trim()) || '';
          if (!categoryAuditMap.has(lookupKey)) {
            categoryAuditMap.set(lookupKey, {
              count: 0,
              sum: 0,
              canonical: catMapping.canonical,
              method: catMapping.method,
            });
          }
          const cStat = categoryAuditMap.get(lookupKey)!;
          cStat.count++;
          cStat.sum += amount;
        }
        incomingTransferAudits.push({
          txId: tx.id,
          date: tx.date,
          amount,
          description: desc,
          counterpartyName,
          counterpartyType: 'SAME_OWNERSHIP_TRANSFER',
          economicNature,
          budgetEffect,
          reviewStatus: 'Confirmado Auto',
          reviewReason: null,
          hasDocumentaryProof: true,
        });
      // Branch 3: Card bill payment leg
      } else if (amount < 0 && isPayment) {
        if (!isCredit) {
          cardBillSettlementCashOutflows += Math.abs(amount);
        }
        economicNature = 'Pagamento de fatura';
        budgetEffect = 'Neutro';
        reviewStatus = 'Confirmado Auto';
        reviewReason = null;
        if (catMapping) {
          categoryPageId = categoryIdByName.get(catMapping.canonical.toLowerCase().trim()) || '';
          if (!categoryAuditMap.has(lookupKey)) {
            categoryAuditMap.set(lookupKey, {
              count: 0,
              sum: 0,
              canonical: catMapping.canonical,
              method: catMapping.method,
            });
          }
          const cStat = categoryAuditMap.get(lookupKey)!;
          cStat.count++;
          cStat.sum += amount;
        }
      // Branch 4: Internal transfer same ownership outflow
      } else if (amount < 0 && isSameOwnership) {
        if (!isCredit) {
          sameOwnershipOutgoingTransfers += Math.abs(amount);
        }
        economicNature = 'Transferência interna';
        budgetEffect = 'Neutro';
        reviewStatus = 'Confirmado Auto';
        reviewReason = null;
        if (catMapping) {
          categoryPageId = categoryIdByName.get(catMapping.canonical.toLowerCase().trim()) || '';
          if (!categoryAuditMap.has(lookupKey)) {
            categoryAuditMap.set(lookupKey, {
              count: 0,
              sum: 0,
              canonical: catMapping.canonical,
              method: catMapping.method,
            });
          }
          const cStat = categoryAuditMap.get(lookupKey)!;
          cStat.count++;
          cStat.sum += amount;
        }
      // Branch 5: Outgoing third-party transfer pending intentional review
      } else if (
        amount < 0 &&
        !isCredit &&
        !isSameOwnership &&
        !isPayment &&
        (lookupKey === '(transferência) || transferências' ||
          (mappedLower === '(transferência)' && descLower.startsWith('transferência enviada')))
      ) {
        economicNature = null;
        budgetEffect = null;
        reviewStatus = 'Pendente Revisão';
        reviewReason =
          'Transferência enviada para terceiro pendente de classificação de categoria e efeito orçamentário';
        categoryPageId = '';
        pendingCategoryReviewCount++;
        pendingThirdPartyOutflows += Math.abs(amount);
      // Branch 6: Standard Expenses (Credit card purchases or Checking expenses)
      } else {
        if (!isCredit && amount < 0) {
          confirmedDirectCheckingExpenses += Math.abs(amount);
        }
        if (catMapping) {
          categoryPageId = categoryIdByName.get(catMapping.canonical.toLowerCase().trim()) || '';
          if (!categoryAuditMap.has(lookupKey)) {
            categoryAuditMap.set(lookupKey, {
              count: 0,
              sum: 0,
              canonical: catMapping.canonical,
              method: catMapping.method,
            });
          }
          const cStat = categoryAuditMap.get(lookupKey)!;
          cStat.count++;
          cStat.sum += amount;
          economicNature = 'Despesa';
          budgetEffect = 'Despesa';
          reviewStatus = 'Confirmado Auto';
          reviewReason = null;
        } else {
          // Genuinely unmapped category - technical error!
          unresolvedCategoryErrorsCount++;
          confidenceStatus = 'UNRESOLVED';
          reviewStatus = 'Pendente Revisão';
          reviewReason = `UNRESOLVED_CATEGORY: Combinação de categoria de origem não homologada (${lookupKey})`;
          categoryPageId = '';
          economicNature = null;
          budgetEffect = null;
        }
      }

      // 9.4. Card Bill Grouping & Dual Relation Semantics
      let billKey: string | null = null;
      let billStableId: string | null = null;
      const isPurchase = isCredit && !isPayment;

      if (isCredit) {
        const upstreamBillId = raw.credit_card_data?.billId;
        if (upstreamBillId) {
          billKey = `BILL_${upstreamBillId}`;
        } else {
          const m = tx.date.substring(0, 7);
          billKey = `PERIOD_${m}`;
        }

        const cycle = cardBillCycles[billKey];
        if (cycle) {
          billStableId = cycle.stableBillId;
          if (isPurchase) {
            cycle.purchases.push(tx);
          }
        }
      }

      // 9.5. Canonical Fingerprint
      const canonicalHash = calculateCanonicalFingerprint({
        source: 'PIERRE',
        sourceAccountId: tx.account_id,
        sourceTransactionId: tx.id,
        amountMinor: BigInt(Math.round(amount * 100)),
        currency: 'BRL',
        scale: 2,
        dateIso: tx.date,
        status: (tx.status || 'CONFIRMED').toUpperCase(),
        description: tx.description,
        rawCategory: tx.category_mapped || tx.category_pierre || '',
        direction: tx.direction,
      });

      // 9.6. Build Canonical Payload conforming strictly to TARGET_CONTRACT
      const sanitizedPayload: Record<string, any> = {
        Lançamento: desc,
        Fonte: 'Pierre',
        'ID da fonte': tx.id,
        Moeda: 'BRL',
        'Hash Canônico': canonicalHash,
        Data: { start: tx.date.substring(0, 10), end: null },
        Valor: Math.abs(amount),
        'Valor Bruto da Fonte': amount,
        Movimento: amount > 0 ? 'Entrada' : 'Saída',
        Natureza: economicNature,
        'Efeito Orçamentário': budgetEffect,
        'Propósito de Alocação': 'Caixa Operacional',
        'Contribuição Meta Poupança': 0,
        Status: tx.status === 'POSTED' ? 'Confirmado' : 'Pendente',
        'Status de Revisão': reviewStatus,
        'Motivo da Revisão': reviewReason || '',
        'Categoria Pierre': tx.category_pierre || '',
        'Descrição original': tx.description,
        'HMAC Contraparte': generateCounterpartyPseudonym(
          counterpartyName,
          effectiveConfig.counterpartyHmacKey,
          effectiveConfig.hmacKeyVersion,
        ),
      };

      // Typed Relations: Conta & Categoria point to existing pages.
      // Fatura Vinculada is assigned STRICTLY to the 20 purchases (type: PLANNED_STABLE_ID).
      const relations: Record<string, TypedRelationReference[]> = {
        Conta: resolvedAccountPageId ? [{ type: 'EXISTING_PAGE_ID', target: resolvedAccountPageId }] : [],
        Categoria: categoryPageId ? [{ type: 'EXISTING_PAGE_ID', target: categoryPageId }] : [],
      };

      if (isPurchase && billStableId) {
        relations['Fatura Vinculada'] = [{ type: 'PLANNED_STABLE_ID', target: billStableId }];
      }

      const dependencies: TypedRelationReference[] = [];
      if (resolvedAccountPageId) dependencies.push({ type: 'EXISTING_PAGE_ID', target: resolvedAccountPageId });
      if (categoryPageId) dependencies.push({ type: 'EXISTING_PAGE_ID', target: categoryPageId });
      if (isPurchase && billStableId) dependencies.push({ type: 'PLANNED_STABLE_ID', target: billStableId });

      // Validate against TARGET_CONTRACT schema
      validateOperationAgainstContract('NOTION_DS_TRANSACTIONS', sanitizedPayload, relations);

      operations.push({
        operationType: 'CREATE',
        classification: 'EXECUTABLE_MIGRATION',
        stage: 'STAGE_1_PAGE_CREATION',
        stableId: tx.id,
        targetDataSource: {
          envKey: 'NOTION_DS_TRANSACTIONS',
          dataSourceId: transactionsDsId,
          name: 'Transações',
        },
        sanitizedPayload,
        relations,
        dependencies,
        reason: 'Lançamento transacional importado deterministicamente do repositório local',
        expectedPriorState: undefined,
      });
    }

    // 10. Payment Legs Audit & Algorithmic Bill Settlement Correlation
    const bankPaymentTxs = sqliteTransactions.filter(
      (t) =>
        t.account_type === 'BANK' &&
        (t.description.toLowerCase().includes('pagamento') ||
          (t.category_pierre && t.category_pierre.toLowerCase().includes('pagamento'))),
    );
    const cardPaymentTxs = sqliteTransactions.filter(
      (t) =>
        t.account_type === 'CREDIT' &&
        (t.description.toLowerCase().includes('pagamento') ||
          (t.category_pierre && t.category_pierre.toLowerCase().includes('pagamento'))),
    );

    const paymentLegAudits: PaymentLegAuditItem[] = [];
    const paymentEventAllocations: PaymentEventAllocation[] = [];
    const pairedCardLegIds = new Set<string>();

    const paymentEvents: Array<{
      eventId: string;
      bankTx: any | null;
      cardTx: any | null;
      canonicalRepresentativeTxId: string;
      amount: number;
      date: string;
      explicitBillId: string | null;
      isShadow: boolean;
    }> = [];

    const pairingAmbiguities: Array<{ bankTxId: string; candidateCardTxIds: string[] }> = [];

    for (const b of bankPaymentTxs) {
      const bTime = new Date(b.date).getTime();
      const bAmt = Math.abs(Number(b.amount));

      // Find candidate card payment legs with exact same amount within 48h
      const candidates = cardPaymentTxs.filter((c) => {
        if (pairedCardLegIds.has(c.id)) return false;
        if (Math.abs(Math.abs(Number(c.amount)) - bAmt) >= 0.001) return false;
        const diff = Math.abs(new Date(c.date).getTime() - bTime);
        return diff <= 1000 * 60 * 60 * 48;
      });

      let bestC: any = null;
      if (candidates.length === 1) {
        bestC = candidates[0];
      } else if (candidates.length > 1) {
        // Disambiguate if one candidate is immediate (< 10 min) and other is delayed batch at 03:00
        const immediateCandidates = candidates.filter((c) => {
          const diff = Math.abs(new Date(c.date).getTime() - bTime);
          const isBatch = c.date.includes('03:00:00') || c.date.endsWith('03:00:00.000Z');
          return diff < 1000 * 60 * 10 && !isBatch;
        });

        if (immediateCandidates.length === 1) {
          bestC = immediateCandidates[0];
        } else {
          // Genuinely ambiguous multiple card legs!
          pairingAmbiguities.push({
            bankTxId: b.id,
            candidateCardTxIds: candidates.map((c) => c.id),
          });
          let bestDiff = Infinity;
          for (const c of candidates) {
            const diff = Math.abs(new Date(c.date).getTime() - bTime);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestC = c;
            }
          }
        }
      }

      if (bestC) {
        pairedCardLegIds.add(bestC.id);
        const cRaw = JSON.parse(bestC.raw_json || '{}');
        const explicitBillId = cRaw.credit_card_data?.billId || null;
        paymentEvents.push({
          eventId: `pevent:${b.id}:${bestC.id}`,
          bankTx: b,
          cardTx: bestC,
          canonicalRepresentativeTxId: b.id,
          amount: bAmt,
          date: b.date,
          explicitBillId,
          isShadow: false,
        });
      } else {
        paymentEvents.push({
          eventId: `pevent:${b.id}`,
          bankTx: b,
          cardTx: null,
          canonicalRepresentativeTxId: b.id,
          amount: bAmt,
          date: b.date,
          explicitBillId: null,
          isShadow: false,
        });
      }
    }

    // Remaining card payment legs: distinguish external card payment from shadow entries using composite evidence
    for (const c of cardPaymentTxs) {
      if (!pairedCardLegIds.has(c.id)) {
        const cRaw = JSON.parse(c.raw_json || '{}');
        const explicitBillId = cRaw.credit_card_data?.billId || null;
        const cTime = new Date(c.date).getTime();
        const cAmt = Math.abs(Number(c.amount));
        const isBatchTimestamp = c.date.includes('03:00:00') || c.date.endsWith('03:00:00.000Z');

        // Composite shadow check: batch timestamp AND matching existing real payment event within 36h
        const matchingRealEvent =
          paymentEvents.find((pe) => {
            if (pe.isShadow) return false;
            if (Math.abs(pe.amount - cAmt) >= 0.001) return false;
            const diff = Math.abs(new Date(pe.date).getTime() - cTime);
            return diff <= 1000 * 60 * 60 * 36;
          }) ||
          cardPaymentTxs.find((otherC) => {
            if (otherC.id === c.id) return false;
            const otherIsBatch = otherC.date.includes('03:00:00') || otherC.date.endsWith('03:00:00.000Z');
            if (otherIsBatch) return false;
            if (Math.abs(Math.abs(Number(otherC.amount)) - cAmt) >= 0.001) return false;
            const diff = Math.abs(new Date(otherC.date).getTime() - cTime);
            return diff <= 1000 * 60 * 60 * 36;
          });

        const isShadow = isBatchTimestamp && Boolean(matchingRealEvent);

        if (!isShadow) {
          paymentEvents.push({
            eventId: `pevent:${c.id}`,
            bankTx: null,
            cardTx: c,
            canonicalRepresentativeTxId: c.id,
            amount: cAmt,
            date: c.date,
            explicitBillId,
            isShadow: false,
          });
        } else {
          paymentEvents.push({
            eventId: `pevent:shadow:${c.id}`,
            bankTx: null,
            cardTx: c,
            canonicalRepresentativeTxId: c.id,
            amount: cAmt,
            date: c.date,
            explicitBillId: null,
            isShadow: true,
          });
        }
      }
    }

    // Allocate payment events to card bill cycles
    for (const event of paymentEvents) {
      if (event.isShadow) {
        // Shadow card payment entry (posted at 03:00 with existing counterpart)
        paymentLegAudits.push({
          txId: event.cardTx.id,
          account: 'Nubank Cartão',
          accountType: 'CREDIT',
          date: event.cardTx.date,
          signedAmount: Number(event.cardTx.amount),
          sourceId: event.cardTx.id,
          possiblePairId: null,
          role: 'UNPAIRED_PAYMENT',
          paymentEventId: event.eventId,
          canonicalRepresentativeTxId: event.canonicalRepresentativeTxId,
          description: event.cardTx.description,
        });
        continue;
      }

      let targetCycle: any = null;
      let method: 'EXPLICIT_UPSTREAM_BILL_ID' | 'CYCLE_WINDOW_CORRELATION' | 'UNRESOLVED_PAYMENT_ALLOCATION' =
        'UNRESOLVED_PAYMENT_ALLOCATION';
      let confidence: 'VERY_HIGH' | 'HIGH' | 'UNRESOLVED' = 'UNRESOLVED';
      let evidence = 'No matching cycle found';

      if (event.explicitBillId) {
        targetCycle = Object.values(cardBillCycles).find((cy) => cy.sourceBillId === event.explicitBillId);
        if (targetCycle) {
          method = 'EXPLICIT_UPSTREAM_BILL_ID';
          confidence = 'VERY_HIGH';
          evidence = `Matched upstream billId '${event.explicitBillId}' from credit_card_data`;
        }
      } else {
        // Generic dynamic matching across all candidate cycles based on settlement window [inicio, vencimento]
        const pDate = event.date.substring(0, 10);
        const candidateCycles = Object.values(cardBillCycles).filter((cy) => {
          const upperDate = cy.vencimento || cy.fechamento;
          return pDate >= cy.inicio && pDate <= upperDate;
        });

        // If multiple candidate cycles match, prioritize open/period cycles because upstream bills already carry explicitBillId
        let matchingCycles = candidateCycles;
        if (matchingCycles.length > 1) {
          const periodCycles = matchingCycles.filter((cy) => cy.origem === 'PERIOD_ESTIMATED');
          if (periodCycles.length > 0) {
            matchingCycles = periodCycles;
          }
        }

        if (matchingCycles.length === 1) {
          targetCycle = matchingCycles[0];
          method = 'CYCLE_WINDOW_CORRELATION';
          confidence = 'HIGH';
          evidence = `Payment date ${pDate} within settlement window [${targetCycle.inicio}, ${targetCycle.vencimento}] for cycle '${targetCycle.stableBillId}'`;
        } else if (matchingCycles.length > 1) {
          method = 'UNRESOLVED_PAYMENT_ALLOCATION';
          confidence = 'UNRESOLVED';
          evidence = `Ambiguous cycle window: payment date ${pDate} matches multiple cycles [${matchingCycles.map((c) => c.stableBillId).join(', ')}]`;
        }
      }

      if (targetCycle) {
        targetCycle.payments.push(event.canonicalRepresentativeTxId);
        paymentEventAllocations.push({
          paymentEventId: event.eventId,
          paymentTxId: event.canonicalRepresentativeTxId,
          billStableId: targetCycle.stableBillId,
          amount: event.amount,
          method,
          confidence,
          evidence,
          canonicalRepresentativeTxId: event.canonicalRepresentativeTxId,
        });
      } else {
        paymentEventAllocations.push({
          paymentEventId: event.eventId,
          paymentTxId: event.canonicalRepresentativeTxId,
          billStableId: '',
          amount: event.amount,
          method: 'UNRESOLVED_PAYMENT_ALLOCATION',
          confidence: 'UNRESOLVED',
          evidence: 'No matching card cycle window found for payment event',
          canonicalRepresentativeTxId: event.canonicalRepresentativeTxId,
        });
      }

      if (event.bankTx) {
        paymentLegAudits.push({
          txId: event.bankTx.id,
          account: 'Nubank Conta',
          accountType: 'BANK',
          date: event.bankTx.date,
          signedAmount: Number(event.bankTx.amount),
          sourceId: event.bankTx.id,
          possiblePairId: event.cardTx?.id || null,
          role: 'BANK_CASH_LEG',
          paymentEventId: event.eventId,
          canonicalRepresentativeTxId: event.canonicalRepresentativeTxId,
          targetBillStableId: targetCycle?.stableBillId,
          allocationMethod: method,
          allocationConfidence: confidence,
          description: event.bankTx.description,
        });
      }

      if (event.cardTx) {
        paymentLegAudits.push({
          txId: event.cardTx.id,
          account: 'Nubank Cartão',
          accountType: 'CREDIT',
          date: event.cardTx.date,
          signedAmount: Number(event.cardTx.amount),
          sourceId: event.cardTx.id,
          possiblePairId: event.bankTx?.id || null,
          role: 'CARD_LIABILITY_LEG',
          paymentEventId: event.eventId,
          canonicalRepresentativeTxId: event.canonicalRepresentativeTxId,
          targetBillStableId: targetCycle?.stableBillId,
          allocationMethod: method,
          allocationConfidence: confidence,
          description: event.cardTx.description,
        });
      }
    }

    // 11. Process Card Bill Cycles & Evaluate Status / Unexplained Discrepancy
    const cardBillAudits: CardBillAuditItem[] = [];

    for (const cycle of Object.values(cardBillCycles)) {
      const purchasesSum = cycle.purchases.reduce((acc, p) => acc + Math.abs(Number(p.amount)), 0);
      const roundedPurchases = Math.round(purchasesSum * 100) / 100;

      const paidSum = cycle.payments.reduce((acc, txId) => {
        const tx = sqliteTransactions.find((t) => t.id === txId);
        return acc + (tx ? Math.abs(Number(tx.amount)) : 0);
      }, 0);
      const roundedPaid = Math.round(paidSum * 100) / 100;

      const purchasePaymentDelta = Math.round(Math.abs(roundedPurchases - roundedPaid) * 100) / 100;
      const valorOficial: number | null = null;
      const officialBillDiscrepancy: number | null = null;
      const unexplainedDiscrepancy: number | null = null;

      // Without official bank statement (valorOficial === null), set status and dataLiquidacao to null (conservative)
      cycle.status = null;
      cycle.dataLiquidacao = null;

      cardBillAudits.push({
        stableBillId: cycle.stableBillId,
        cartao: cycle.cartao,
        inicio: cycle.inicio,
        fim: cycle.fim,
        fechamento: cycle.fechamento,
        vencimento: cycle.vencimento,
        dataLiquidacao: null,
        status: null,
        origem: cycle.origem,
        qualidade: cycle.qualidade,
        tipoCiclo: cycle.tipoCiclo,
        nCompras: cycle.purchases.length,
        somaCompras: roundedPurchases,
        valorOficial: null,
        valorAproximado: null,
        componentesAdicionais: null,
        diferenca: purchasePaymentDelta,
        purchasePaymentDelta,
        officialBillDiscrepancy: null,
        unexplainedDiscrepancy: null,
        paidAmount: roundedPaid,
        fieldProvenance: cycle.fieldProvenance,
      });

      // Canonical payload for NOTION_DS_CARD_BILLS
      const billPayload: Record<string, any> = {
        'Fatura / Ciclo': cycle.title,
        Fonte: 'Pierre',
        'ID da Fatura na Fonte': cycle.sourceBillId,
        'ID Estável da Fatura': cycle.stableBillId,
        'Qualidade da Identidade': cycle.origem === 'UPSTREAM_BILL_ID' ? 'SOURCE_ID' : 'PERIOD_FALLBACK',
        Moeda: 'BRL',
        'Início do Período': { start: cycle.inicio, end: null },
        'Fim do Período': { start: cycle.fim, end: null },
        'Data de Fechamento': { start: cycle.fechamento, end: null },
        'Data de Vencimento': cycle.vencimento ? { start: cycle.vencimento, end: null } : null,
        'Tipo de Ciclo': cycle.tipoCiclo,
        'Origem / Qualidade dos Dados': cycle.qualidade,
        'Status da Fatura': null,
        'Valor da Fatura Fechada (Oficial)': null,
        'Valor Estimado da Fatura Aberta': null,
        'Total de Compras no Ciclo': roundedPurchases,
        'Componentes Adicionais da Fatura': null,
        'Divergência Não Explicada': null,
        'Valor Pago': roundedPaid,
        'Data de Liquidação': null,
      };

      const cyclePurchasesRefs: TypedRelationReference[] = cycle.purchases.map((p) => ({
        type: 'PLANNED_STABLE_ID',
        target: p.id,
      }));

      const cyclePaymentsRefs: TypedRelationReference[] = cycle.payments.map((id) => ({
        type: 'PLANNED_STABLE_ID',
        target: id,
      }));

      const billRelations: Record<string, TypedRelationReference[]> = {
        'Cartão Vinculado': [{ type: 'EXISTING_PAGE_ID', target: nubankCartaoPage.id }],
        'Lançamentos do Ciclo': cyclePurchasesRefs, // strictly the purchases!
        'Transações de Pagamento': cyclePaymentsRefs, // strictly the allocated payment transactions!
      };

      const billDependencies: TypedRelationReference[] = [
        { type: 'EXISTING_PAGE_ID', target: nubankCartaoPage.id },
        ...cyclePurchasesRefs,
        ...cyclePaymentsRefs,
      ];

      // Validate against TARGET_CONTRACT schema
      validateOperationAgainstContract('NOTION_DS_CARD_BILLS', billPayload, billRelations);

      operations.push({
        operationType: 'CREATE',
        classification: 'EXECUTABLE_MIGRATION',
        stage: 'STAGE_1_PAGE_CREATION',
        stableId: cycle.stableBillId,
        targetDataSource: {
          envKey: 'NOTION_DS_CARD_BILLS',
          dataSourceId: cardBillsDsId,
          name: 'Faturas / Ciclos de Cartão',
        },
        sanitizedPayload: billPayload,
        relations: billRelations,
        dependencies: billDependencies,
        reason: 'Ciclo de fatura de cartão de crédito projetado para desacoplamento de competência de faturamento',
        expectedPriorState: undefined,
      });
    }

    // 12. Proposed Derived Updates (EXCLUDED FROM EXECUTABLE OPERATIONS - STRICTLY EMPTY)
    const proposedDerivedUpdates: ProposedDerivedUpdateAudit[] = [];

    // 13. Category Reconciliation Summary
    const categoryReconciliations: CategoryReconciliationItem[] = [];
    for (const [k, v] of categoryAuditMap.entries()) {
      categoryReconciliations.push({
        categoriaLegado: k,
        categoriaCanonica: v.canonical,
        quantidade: v.count,
        soma: Math.round(v.sum * 100) / 100,
        metodoMapeamento: v.method,
      });
    }

    // 14. Validate Dependency Graph
    const allStableIds = new Set(operations.map((o) => o.stableId));
    for (const op of operations) {
      for (const dep of op.dependencies) {
        if (dep.type === 'PLANNED_STABLE_ID' && !allStableIds.has(dep.target)) {
          throw new Error(
            `DEPENDENCY_GRAPH_ERROR: Operação '${op.stableId}' referencia stableId inexistente '${dep.target}'.`,
          );
        }
      }
    }

    // 15. Deterministic Backfill Plan Hash
    const deterministicPayload = {
      mappingVersion,
      commitSha,
      sourceSnapshotHash,
      targetNotionSnapshotHash,
      targetStateHash,
      upstreamBillEnrichmentHash: options.upstreamBillEnrichmentHash || null,
      plannerConfigHash: calculateSemanticConfigHash(effectiveConfig),
      operations: operations.map((op) => ({
        operationType: op.operationType,
        classification: op.classification,
        stage: op.stage,
        stableId: op.stableId,
        targetEnvKey: op.targetDataSource.envKey,
        sanitizedPayload: op.sanitizedPayload,
        relations: op.relations,
        dependencies: op.dependencies,
        reason: op.reason,
      })),
    };

    const payloadJson = JSON.stringify(deterministicPayload);
    let backfillPlanHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
    if (options._forceIrreproducibleHash && !options._isReproducibilityCheck) {
      backfillPlanHash = '0'.repeat(64);
    }

    // Verify reproducibility by instantiating an independent planner instance with identical options
    let planHashReproducible = false;
    if (!options._isReproducibilityCheck) {
      const independentPlanner = new BackfillPlanner({ dbPath: this.dbPath, envVars: this.envVars });
      const secondArtifact = independentPlanner.generateArtifact({
        ...options,
        _isReproducibilityCheck: true,
      });
      planHashReproducible =
        secondArtifact.artifact.backfillPlanHash === backfillPlanHash &&
        secondArtifact.artifact.operations.length === operations.length &&
        backfillPlanHash.length === 64;
    } else {
      planHashReproducible = backfillPlanHash.length === 64;
    }

    // 16. Dynamic Readiness Calculations (Zero Hardcoded Booleans)
    const isWorktreeClean = (() => {
      try {
        const out = execSync('git status --porcelain', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
        return out.length === 0;
      } catch {
        return false;
      }
    })();

    const isHeadInSync = (() => {
      try {
        const localHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        const remoteHead = execSync('git rev-parse @{u}', { encoding: 'utf8' }).trim();
        return localHead === remoteHead;
      } catch {
        return false;
      }
    })();

    const canonicalTxHashes = operations
      .filter((o) => o.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS')
      .map((o) => o.sanitizedPayload['Hash Canônico']);
    const duplicatesZero = new Set(canonicalTxHashes).size === canonicalTxHashes.length;

    const identityCollisionsZero = allStableIds.size === operations.length;
    const unresolvedAccountsZero = unresolvedAccountsCount === 0;
    const unresolvedCategoryErrorsZero = unresolvedCategoryErrorsCount === 0;
    const unresolvedCategoriesZero = unresolvedCategoryErrorsCount === 0;
    const unresolvedPaymentAllocationsCount = paymentEventAllocations.filter(
      (a) => a.method === 'UNRESOLVED_PAYMENT_ALLOCATION',
    ).length;
    const unresolvedPaymentAllocationsZero = unresolvedPaymentAllocationsCount === 0;
    const paymentPairingAmbiguitiesZero = pairingAmbiguities.length === 0;
    const paymentAllocationsResolved = unresolvedPaymentAllocationsCount === 0;

    // Conservative import-safety check: validates cycle date structures and safe status inference when official evidence is absent.
    const billStructuralValidity =
      cardBillAudits.length > 0 &&
      cardBillAudits.every(
        (b) =>
          isValidIsoDate(b.inicio) &&
          isValidIsoDate(b.fim) &&
          isValidIsoDate(b.fechamento) &&
          (b.vencimento === null || isValidIsoDate(b.vencimento)),
      );
    const billOfficialEvidenceAvailable = cardBillAudits.some((b) => b.valorOficial !== null);
    const billStatusInferenceSafe = cardBillAudits.every((b) =>
      b.valorOficial === null ? b.status === null : true,
    );
    const billReconciliationEvidenceSufficient = billStructuralValidity && billStatusInferenceSafe;

    // Fail-closed snapshot validation: absence of evidence evaluates strictly to false
    const ciphertextIntegrityValid = Boolean(options.snapshotValidation?.ciphertextIntegrityValid);
    const manifestIntegrityValid = Boolean(options.snapshotValidation?.manifestIntegrityValid);
    const manifestStructureAndHashReferencesValid = manifestIntegrityValid;
    const plaintextRestoreVerified = Boolean(options.snapshotValidation?.plaintextRestoreVerified);

    const sourceSnapshotCiphertextValid = Boolean(options.snapshotValidation?.sourceSnapshotCiphertextValid);
    const sourceSnapshotManifestValid = Boolean(options.snapshotValidation?.sourceSnapshotManifestValid);
    const sourceSnapshotRestoreVerified = Boolean(options.snapshotValidation?.sourceSnapshotRestoreVerified);

    const targetSnapshotValid = Boolean(targetNotionSnapshotHash && targetNotionSnapshotHash.length === 64);
    const targetLiveDriftZero = Boolean(
      options.targetLiveDriftZero !== undefined
        ? options.targetLiveDriftZero
        : options.snapshotValidation?.targetLiveDriftZero !== undefined
        ? options.snapshotValidation.targetLiveDriftZero
        : false,
    );
    const sourceBackupValid = Boolean(
      sourceSnapshotHash &&
      sourceSnapshotHash.length === 64 &&
      sourceSnapshotCiphertextValid &&
      sourceSnapshotManifestValid &&
      sourceSnapshotRestoreVerified,
    );


    // Dynamic Financial Discrepancy & Cash Flow Reconciliation
    const roundedDirectChecking = Math.round(confirmedDirectCheckingExpenses * 100) / 100;
    const roundedPendingOutflows = Math.round(pendingThirdPartyOutflows * 100) / 100;
    const roundedInternalTransfers = Math.round(sameOwnershipOutgoingTransfers * 100) / 100;
    const roundedBillSettlements = Math.round(cardBillSettlementCashOutflows * 100) / 100;

    const totalCardPurchases = sqliteTransactions
      .filter((t) => {
        if (t.account_type !== 'CREDIT' || Number(t.amount) >= 0) return false;
        const isPayment =
          t.description.toLowerCase().includes('pagamento') ||
          (t.category_pierre && t.category_pierre.toLowerCase().includes('pagamento'));
        return !isPayment;
      })
      .reduce((acc, t) => acc + Math.abs(Number(t.amount)), 0);
    const roundedCardPurchases = Math.round(totalCardPurchases * 100) / 100;

    // Confirmed Economic Expenses: Direct checking expenses + Credit card purchases
    const confirmedEconomicExpenses =
      options._mockExpectedEconomicExpenses !== undefined
        ? options._mockExpectedEconomicExpenses
        : Math.round((roundedDirectChecking + roundedCardPurchases) * 100) / 100;

    // Pending Economic Outflows: Outgoing third-party transfers pending review
    const pendingEconomicOutflows = roundedPendingOutflows;

    // Physical Cash Outflows: Dynamic sum of all checking cash outflows
    const physicalCashOutflows = Math.round(allCheckingOutflowsSum * 100) / 100;

    const totalExpenseOperations = operations
      .filter((o) => o.sanitizedPayload['Efeito Orçamentário'] === 'Despesa')
      .reduce((acc, o) => acc + Number(o.sanitizedPayload['Valor']), 0);
    const roundedExpenseOperations = Math.round(totalExpenseOperations * 100) / 100;

    const classifiedEconomicReconciliationZero =
      Math.abs(confirmedEconomicExpenses - roundedExpenseOperations) < 0.001;
    const cashFlowReconciliationZero =
      Math.abs(
        physicalCashOutflows -
          (roundedDirectChecking + roundedPendingOutflows + roundedInternalTransfers + roundedBillSettlements),
      ) < 0.001;
    const financialDiscrepancyZero =
      classifiedEconomicReconciliationZero && cashFlowReconciliationZero;

    // Dynamic Schema Conformance Checks (from explicit live/mock evidence)
    const schemaEvidence = options.schemaEvidence;
    const schemaConformant13Of13 = Boolean(
      schemaEvidence &&
        schemaEvidence.totalDataSources === 13 &&
        schemaEvidence.verifiedDataSources === 13,
    );
    const missingPropertiesZero = Boolean(
      schemaEvidence && schemaEvidence.missingPropertiesCount === 0,
    );
    const structuralMismatchesZero = Boolean(
      schemaEvidence && schemaEvidence.structuralMismatchesCount === 0,
    );

    const pendingEconomicClassificationCount =
      incomingTransferAudits.filter((t) => t.counterpartyType !== 'SAME_OWNERSHIP_TRANSFER').length +
      pendingCategoryReviewCount;

    const checks = {
      schemaConformant13Of13,
      missingPropertiesZero,
      structuralMismatchesZero,
      duplicatesZero,
      unresolvedAccountsZero,
      unresolvedCategoryErrorsZero,
      unresolvedCategoriesZero,
      unresolvedPaymentAllocationsZero,
      paymentPairingAmbiguitiesZero,
      paymentAllocationsResolved,
      billStructuralValidity,
      billOfficialEvidenceAvailable,
      billStatusInferenceSafe,
      billReconciliationEvidenceSufficient,
      cashFlowReconciliationZero,
      classifiedEconomicReconciliationZero,
      financialDiscrepancyZero,
      identityCollisionsZero,
      targetSnapshotValid,
      targetLiveDriftZero,
      sourceBackupValid,
      ciphertextIntegrityValid,
      manifestIntegrityValid,
      manifestStructureAndHashReferencesValid,
      plaintextRestoreVerified,
      sourceSnapshotCiphertextValid,
      sourceSnapshotManifestValid,
      sourceSnapshotRestoreVerified,
      worktreeClean: isWorktreeClean,
      headInSyncWithRemote: isHeadInSync,
      planHashReproducible,
    };

    const blockers: string[] = [];
    if (!checks.worktreeClean) {
      blockers.push('WORKTREE_DIRTY: Working tree possui alterações pendentes que devem ser commitadas.');
    }
    if (!checks.headInSyncWithRemote) {
      blockers.push('HEAD_NOT_IN_SYNC: O commit local difere ou ainda não foi enviado para a branch remota vinculada.');
    }
    if (!checks.schemaConformant13Of13) {
      blockers.push('SCHEMA_NON_CONFORMANT: Notion live não possui as 13 bases canônicas verificadas.');
    }
    if (!checks.missingPropertiesZero) {
      blockers.push('SCHEMA_MISSING_PROPERTIES: Existem propriedades obrigatórias ausentes no Notion live.');
    }
    if (!checks.structuralMismatchesZero) {
      blockers.push('SCHEMA_STRUCTURAL_MISMATCHES: Existem incompatibilidades estruturais no Notion live.');
    }
    if (!checks.unresolvedAccountsZero) {
      blockers.push(`UNRESOLVED_ACCOUNTS: Existem ${unresolvedAccountsCount} transações com conta não resolvida.`);
    }
    if (!checks.unresolvedCategoryErrorsZero) {
      blockers.push(
        `UNRESOLVED_CATEGORY_ERRORS: Existem ${unresolvedCategoryErrorsCount} transações com erro técnico de categoria não homologada.`,
      );
    }
    if (!checks.unresolvedPaymentAllocationsZero) {
      blockers.push(
        `UNRESOLVED_PAYMENT_ALLOCATIONS: Existem ${unresolvedPaymentAllocationsCount} pagamentos não alocados a ciclos.`,
      );
    }
    if (!checks.paymentPairingAmbiguitiesZero) {
      blockers.push(
        `AMBIGUOUS_PAYMENT_PAIR: Detectadas ${pairingAmbiguities.length} ambiguidades no pareamento de pernas de pagamento.`,
      );
    }
    if (!checks.paymentAllocationsResolved) {
      blockers.push('UNRESOLVED_PAYMENT_ALLOCATIONS: Pagamentos de fatura não alocados a ciclos.');
    }
    if (!checks.billStructuralValidity) {
      blockers.push('BILL_STRUCTURAL_INVALID: Ciclos de fatura com estrutura de datas inválida.');
    }
    if (!checks.billStatusInferenceSafe) {
      blockers.push('BILL_STATUS_INFERENCE_UNSAFE: Inferência de status de fatura insegura na ausência de valor oficial.');
    }
    if (!checks.billReconciliationEvidenceSufficient) {
      blockers.push('BILL_EVIDENCE_INSUFFICIENT: Evidência insuficiente ou datas inválidas na reconciliação de faturas.');
    }
    if (!checks.ciphertextIntegrityValid) {
      blockers.push('SNAPSHOT_CIPHERTEXT_INVALID: Falha na integridade do arquivo cifrado do snapshot.');
    }
    if (!checks.manifestIntegrityValid) {
      blockers.push('SNAPSHOT_MANIFEST_INVALID: Falha na integridade do manifesto do snapshot.');
    }
    if (!checks.plaintextRestoreVerified) {
      blockers.push('SNAPSHOT_RESTORE_UNVERIFIED: Restauração do snapshot para texto plano não verificada.');
    }
    if (!checks.targetLiveDriftZero) {
      blockers.push('TARGET_DRIFT_DETECTED: Divergência detectada entre o estado live do Notion e o snapshot congelado.');
    }
    if (!checks.sourceSnapshotCiphertextValid) {
      blockers.push('SOURCE_SNAPSHOT_CIPHERTEXT_INVALID: Falha na integridade do arquivo cifrado do snapshot SQLite de origem.');
    }
    if (!checks.sourceSnapshotManifestValid) {
      blockers.push('SOURCE_SNAPSHOT_MANIFEST_INVALID: Falha na integridade do manifesto do snapshot SQLite de origem.');
    }
    if (!checks.sourceSnapshotRestoreVerified) {
      blockers.push('SOURCE_SNAPSHOT_RESTORE_UNVERIFIED: Restauração do snapshot SQLite de origem não verificada via AES-256-GCM.');
    }

    if (!checks.cashFlowReconciliationZero) {
      blockers.push('CASH_FLOW_DISCREPANCY: Discrepância na reconciliação de fluxo de caixa físico.');
    }
    if (!checks.classifiedEconomicReconciliationZero) {
      blockers.push('ECONOMIC_RECONCILIATION_DISCREPANCY: Discrepância na reconciliação de despesas econômicas.');
    }
    if (!checks.financialDiscrepancyZero) {
      blockers.push('FINANCIAL_DISCREPANCY: Discrepância financeira residual detectada.');
    }
    if (!checks.duplicatesZero) {
      blockers.push('DUPLICATE_CANONICAL_HASHES: Foram encontradas impressões digitais de transação duplicadas.');
    }
    if (!checks.identityCollisionsZero) {
      blockers.push('STABLE_ID_COLLISIONS: Colisões encontradas nos identificadores estáveis do plano.');
    }
    if (!checks.planHashReproducible) {
      blockers.push('PLAN_HASH_IRREPRODUCIBLE: Divergência na reprodução do backfillPlanHash.');
    }

    const readyForExecutorImplementation = blockers.length === 0;
    const readyForApply = false; // Strictly false in Phase 2A: apply executor not yet implemented/authorized!

    const executableCreateCount = operations.filter(
      (o) => o.operationType === 'CREATE' && o.classification === 'EXECUTABLE_MIGRATION',
    ).length;
    const executableUpdateCount = operations.filter(
      (o) => o.operationType === 'UPDATE' && o.classification === 'EXECUTABLE_MIGRATION',
    ).length;
    const proposedReviewCount = 0; // Derived updates are OUT_OF_SCOPE_NOT_EXECUTED and excluded from operations

    const totalRelations = operations.reduce(
      (acc, o) => acc + Object.values(o.relations).reduce((rAcc, r) => rAcc + r.length, 0),
      0,
    );

    const byTargetDataSource: Record<string, number> = {};
    for (const op of operations) {
      byTargetDataSource[op.targetDataSource.envKey] = (byTargetDataSource[op.targetDataSource.envKey] || 0) + 1;
    }

    const artifact: BackfillPlanArtifact = {
      version: '2.2.0',
      mappingVersion,
      generatedAt,
      commitSha,
      sourceSnapshotHash,
      targetNotionSnapshotHash: targetNotionSnapshotHash as string,
      upstreamBillEnrichmentHash: options.upstreamBillEnrichmentHash,
      backfillPlanHash,
      explicitSnapshots: {
        sourceDbPath: effectiveDbPath,
        sourceDbSha256: sourceSnapshotHash,
        sourceSnapshotManifestPath: options.snapshotValidation?.sourceSnapshotManifestPath,
        sourceSnapshotCiphertextSha256: options.snapshotValidation?.sourceSnapshotEncryptedSha256,
        sourceSnapshotPlaintextSha256: options.snapshotValidation?.sourceSnapshotPlaintextSha256,
        targetNotionManifestPath: targetManifestPath as string,
        targetNotionSnapshotSha256: targetNotionSnapshotHash as string,
        targetStateHash: targetStateHash || undefined,
      },
      executionPlan: {
        stage1CreationsCount: executableCreateCount,
        stage2RelationPatchesCount: totalRelations,
      },
      summary: {
        totalOperations: operations.length,
        executableCreateCount,
        executableUpdateCount,
        proposedReviewCount,
        totalRelations,
        byTargetDataSource,
      },
      operations,
      readiness: {
        readyForExecutorImplementation,
        readyForApply,
        blockers,
        pendingEconomicClassificationCount,
        pendingCategoryReviewCount,
        confirmedEconomicExpenses,
        pendingEconomicOutflows,
        physicalCashOutflows,
        confirmedDirectCheckingExpenses: roundedDirectChecking,
        pendingThirdPartyOutflows: roundedPendingOutflows,
        sameOwnershipOutgoingTransfers: roundedInternalTransfers,
        cardBillSettlementCashOutflows: roundedBillSettlements,
        checks,
      },
      securityGates: {
        enabledVar: 'FINANCIAL_BACKFILL_ENABLED',
        expectedEnabledValue: 'I_UNDERSTAND_BACKFILL_MUTATIONS',
        planHashVar: 'FINANCIAL_BACKFILL_PLAN_HASH',
        commitShaVar: 'FINANCIAL_BACKFILL_COMMIT_SHA',
      },
    };

    return {
      artifact,
      transactionAudits,
      cardBillAudits,
      categoryReconciliations,
      proposedDerivedUpdates,
      paymentLegAudits,
      incomingTransferAudits,
      paymentEventAllocations,
    };
  }
}
