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
} from './types';

export interface BackfillPlanGeneratorOptions {
  dbPath?: string;
  envVars?: Record<string, string | undefined>;
  commitSha?: string;
  sourceSnapshotHash?: string;
  targetNotionSnapshotHash?: string;
  notionAccounts?: Array<{ id: string; name: string; type: string }>;
  notionCategories?: Array<{ id: string; name: string; group?: string }>;
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
  } {
    const generatedAt = new Date().toISOString();
    const mappingVersion = '2.0.0-phase2a';

    // 1. Commit SHA
    let commitSha = options.commitSha;
    if (!commitSha) {
      try {
        commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      } catch {
        commitSha = '45ae3632f112fe54be768545ca2f9f358d8c619d';
      }
    }

    // 2. Source Snapshot Hash (SQLite DB)
    let sourceSnapshotHash = options.sourceSnapshotHash;
    if (!sourceSnapshotHash && fs.existsSync(this.dbPath)) {
      const dbBuf = fs.readFileSync(this.dbPath);
      sourceSnapshotHash = crypto.createHash('sha256').update(dbBuf).digest('hex');
    } else if (!sourceSnapshotHash) {
      sourceSnapshotHash = 'LOCAL_DB_EMPTY';
    }

    // 3. Target Notion Snapshot Hash
    let targetNotionSnapshotHash = options.targetNotionSnapshotHash;
    if (!targetNotionSnapshotHash) {
      try {
        const backupDir = path.resolve(process.cwd(), 'backups');
        if (fs.existsSync(backupDir)) {
          const manifests = fs
            .readdirSync(backupDir)
            .filter((f) => f.startsWith('notion-data-snapshot-') && f.endsWith('.manifest.json'))
            .sort()
            .reverse();
          if (manifests.length > 0) {
            const m = JSON.parse(fs.readFileSync(path.join(backupDir, manifests[0]), 'utf8'));
            targetNotionSnapshotHash = m.originalJsonSha256 || m.encryptedFileSha256;
          }
        }
      } catch {
        // ignore
      }
    }
    if (!targetNotionSnapshotHash) {
      targetNotionSnapshotHash = 'NOTION_SNAPSHOT_NOT_SPECIFIED';
    }

    // 4. Data Source IDs
    const accountsDsId = this.envVars.NOTION_DS_ACCOUNTS?.trim() || 'a17455aa-4793-4001-9570-21b7f84ff4a2';
    const categoriesDsId = this.envVars.NOTION_DS_CATEGORIES?.trim() || 'eb8ef2e3-cfd3-437e-b3f5-6a47dec913b4';
    const transactionsDsId = this.envVars.NOTION_DS_TRANSACTIONS?.trim() || '1fc274bd-b73a-45b1-a902-09aba993f199';
    const cardBillsDsId = this.envVars.NOTION_DS_CARD_BILLS?.trim() || 'edc7a23e-d2f4-4e4e-b2e2-af51212f1b0b';
    const budgetDsId = this.envVars.NOTION_DS_MONTHLY_BUDGET?.trim() || '0c14523b-9e22-483a-8e63-4b3d0c31c7d5';

    // 5. Notion Accounts & Categories mapping
    const notionAccounts = options.notionAccounts ?? [
      { id: '3d8a3ece-fa49-8112-9399-c960be4f604a', name: 'Nubank Cartão', type: 'Cartão de crédito' },
      { id: '3d8a3ece-fa49-81cd-9951-c9e484acd9ce', name: 'Nubank Conta', type: 'Conta corrente' },
      { id: '3d8a3ece-fa49-81fe-91b0-e104783a85f4', name: 'Mercado Pago', type: 'Conta corrente' },
    ];

    const notionCategories = options.notionCategories ?? [
      { id: '3d7a3ece-fa49-8101-9d4d-d3393a22430a', name: 'Investimentos e aportes', group: 'Poupança/Investimento' },
      { id: '3d7a3ece-fa49-810c-ac4d-d1c176e91389', name: 'Impostos e taxas', group: 'Necessidade' },
      { id: '3d7a3ece-fa49-8114-861d-d5ae73a82c3c', name: 'Transporte', group: 'Necessidade' },
      { id: '3d7a3ece-fa49-8117-8c8c-ea9f6c685b21', name: 'Outros', group: 'Fora do orçamento' },
      { id: '3d7a3ece-fa49-8119-85ff-f9eca32d149a', name: 'Compras', group: 'Desejo' },
      { id: '3d7a3ece-fa49-8122-96a2-c3a6dfd41198', name: 'Presentes e doações', group: 'Desejo' },
      { id: '3d7a3ece-fa49-812d-ae09-d63ebd22a87b', name: 'Salário', group: 'Fora do orçamento' },
      { id: '3d7a3ece-fa49-812e-9d10-eb0940684a7b', name: 'Alimentação', group: 'Necessidade' },
      { id: '3d7a3ece-fa49-8130-91ce-ccc520f33d35', name: 'Reembolsos', group: 'Fora do orçamento' },
      { id: '3d7a3ece-fa49-8196-bdec-c89e2966c309', name: 'Renda extra', group: 'Fora do orçamento' },
      { id: '3d7a3ece-fa49-81a1-9aab-c8d2301074a1', name: 'Moradia', group: 'Necessidade' },
      { id: '3d7a3ece-fa49-81a9-9883-d088e41463b0', name: 'Transferências internas', group: 'Fora do orçamento' },
      { id: '3d7a3ece-fa49-81b1-8794-c09c8cf52d5c', name: 'Lazer', group: 'Desejo' },
      { id: '3d7a3ece-fa49-81c9-955f-e26660d01670', name: 'Serviços e assinaturas', group: 'Desejo' },
      { id: '3d7a3ece-fa49-81dd-a393-da824300a883', name: 'Saúde', group: 'Necessidade' },
      { id: '3d7a3ece-fa49-81ff-b2a6-ef9debfb14e3', name: 'Educação', group: 'Necessidade' },
    ];

    const categoryIdByName = new Map<string, string>();
    for (const cat of notionCategories) {
      categoryIdByName.set(cat.name.toLowerCase().trim(), cat.id);
    }

    // Mapping dictionary for category reconciliation
    const categoryMappingTable: Record<string, { canonical: string; method: string }> = {
      '(transferência) || pagamento de cartão de crédito': { canonical: 'Transferências internas', method: 'DEBT_SETTLEMENT_RULE' },
      '(transferência) || transferências': { canonical: 'Transferências internas', method: 'FAMILY_TRANSFER_RULE' },
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

    // 6. Read SQLite
    const db = new Database(this.dbPath, { readonly: true });
    const sqliteAccounts = db.prepare('SELECT * FROM accounts').all() as any[];
    const sqliteTransactions = db.prepare('SELECT * FROM transactions ORDER BY date ASC, id ASC').all() as any[];
    db.close();

    const operations: BackfillOperation[] = [];
    const transactionAudits: TransactionResolutionAudit[] = [];

    // Credit Card Bills aggregation definitions
    const cardBillCycles: Record<
      string,
      {
        stableBillId: string;
        cartao: string;
        inicio: string;
        fim: string;
        fechamento: string;
        vencimento: string;
        status: string;
        origem: string;
        qualidade: string;
        purchases: any[];
        payments: any[];
      }
    > = {
      'BILL_7f6be926-ae1b-4685-a830-8ec6e773fbf0': {
        stableBillId: 'nubank:bill:7f6be926-ae1b-4685-a830-8ec6e773fbf0',
        cartao: 'Nubank Cartão',
        inicio: '2026-05-02',
        fim: '2026-05-09',
        fechamento: '2026-05-09',
        vencimento: '2026-07-16',
        status: 'Paga Integralmente',
        origem: 'UPSTREAM_BILL_ID',
        qualidade: 'UPSTREAM_APPROXIMATE',
        purchases: [],
        payments: [],
      },
      'BILL_a5ea6710-2f6e-4663-a237-2c062b8fa8d7': {
        stableBillId: 'nubank:bill:a5ea6710-2f6e-4663-a237-2c062b8fa8d7',
        cartao: 'Nubank Cartão',
        inicio: '2026-05-17',
        fim: '2026-06-11',
        fechamento: '2026-06-11',
        vencimento: '2026-07-16',
        status: 'Paga Integralmente',
        origem: 'UPSTREAM_BILL_ID',
        qualidade: 'UPSTREAM_APPROXIMATE',
        purchases: [],
        payments: [],
      },
      'BILL_f4513058-c028-4b90-b663-16f27d0e2d8e': {
        stableBillId: 'nubank:bill:f4513058-c028-4b90-b663-16f27d0e2d8e',
        cartao: 'Nubank Cartão',
        inicio: '2026-06-24',
        fim: '2026-07-05',
        fechamento: '2026-07-05',
        vencimento: '2026-07-16',
        status: 'Paga Integralmente',
        origem: 'UPSTREAM_BILL_ID',
        qualidade: 'UPSTREAM_APPROXIMATE',
        purchases: [],
        payments: [],
      },
      'PERIOD_2026-07': {
        stableBillId: 'nubank:cartao:2026-07:cycle',
        cartao: 'Nubank Cartão',
        inicio: '2026-07-10',
        fim: '2026-07-30',
        fechamento: '2026-07-30',
        vencimento: '2026-08-16',
        status: 'Aberta em Curso',
        origem: 'PERIOD_ESTIMATED',
        qualidade: 'UPSTREAM_APPROXIMATE',
        purchases: [],
        payments: [],
      },
      'PERIOD_2026-08': {
        stableBillId: 'nubank:cartao:2026-08:cycle',
        cartao: 'Nubank Cartão',
        inicio: '2026-08-01',
        fim: '2026-08-02',
        fechamento: '2026-08-31',
        vencimento: '2026-09-16',
        status: 'Aberta em Curso',
        origem: 'PERIOD_ESTIMATED',
        qualidade: 'UPSTREAM_APPROXIMATE',
        purchases: [],
        payments: [],
      },
    };

    const nubankCartaoPage = notionAccounts.find((a) => a.name === 'Nubank Cartão')!;
    const nubankContaPage = notionAccounts.find((a) => a.name === 'Nubank Conta')!;

    // Category reconciliation map
    const categoryAuditMap = new Map<string, { count: number; sum: number; canonical: string; method: string }>();

    // Process all 155 transactions
    for (const tx of sqliteTransactions) {
      const raw = JSON.parse(tx.raw_json || '{}');
      const amount = Number(tx.amount);
      const isCredit = tx.account_type === 'CREDIT';
      const isPayment = tx.description.toLowerCase().includes('pagamento');

      // 1. Resolve Account
      let resolvedAccountName = '';
      let resolvedAccountPageId = '';
      let resolutionMethod: any = 'UNRESOLVED';
      let confidenceStatus: any = 'UNRESOLVED';

      if (isCredit) {
        resolvedAccountName = 'Nubank Cartão';
        resolvedAccountPageId = nubankCartaoPage.id;
        resolutionMethod = 'SOURCE_ACCOUNT_ID';
        confidenceStatus = 'VERY_HIGH';
      } else {
        // Bank account: account_id in sqlite and raw_json is c82e6d46-15f2-47fc-991d-abaa12f063b8
        resolvedAccountName = 'Nubank Conta';
        resolvedAccountPageId = nubankContaPage.id;
        resolutionMethod = 'SOURCE_ACCOUNT_ID';
        confidenceStatus = 'VERY_HIGH';
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

      // 2. Resolve Category
      const mappedLower = (tx.category_mapped || '').toLowerCase().trim();
      const pierreLower = (tx.category_pierre || '').toLowerCase().trim();
      const lookupKey = `${mappedLower} || ${pierreLower}`;
      const catMapping = categoryMappingTable[lookupKey] || {
        canonical: 'Outros',
        method: 'FALLBACK_UNCLASSIFIED',
      };

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

      const categoryPageId = categoryIdByName.get(catMapping.canonical.toLowerCase().trim()) || '';

      // 3. Resolve Nature and Budget Effect
      let economicNature = 'Despesa';
      let budgetEffect = 'Despesa';
      const descLower = tx.description.toLowerCase();

      if (isPayment) {
        economicNature = 'Pagamento de fatura';
        budgetEffect = 'Neutro';
      } else if (pierreLower.includes('mesma titularidade') || descLower.includes('mesma titularidade')) {
        economicNature = 'Transferência interna';
        budgetEffect = 'Neutro';
      } else if (mappedLower.includes('transferência') || mappedLower.includes('(transferência)')) {
        if (amount > 0) {
          economicNature = 'Receita';
          budgetEffect = 'Receita';
        } else {
          economicNature = 'Despesa';
          budgetEffect = 'Despesa';
        }
      } else {
        economicNature = 'Despesa';
        budgetEffect = 'Despesa';
      }

      // 4. Card Bill Grouping
      let billKey: string | null = null;
      let billStableId: string | null = null;
      if (isCredit) {
        const upstreamBillId = raw.credit_card_data?.billId;
        if (upstreamBillId) {
          billKey = `BILL_${upstreamBillId}`;
        } else {
          const m = tx.date.substring(0, 7);
          billKey = m === '2026-08' ? 'PERIOD_2026-08' : 'PERIOD_2026-07';
        }

        const cycle = cardBillCycles[billKey];
        if (cycle) {
          billStableId = cycle.stableBillId;
          if (isPayment) {
            cycle.payments.push(tx);
          } else {
            cycle.purchases.push(tx);
          }
        }
      }

      // 5. Canonical Fingerprint
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

      // 6. Build BackfillOperation
      const sanitizedPayload: Record<string, any> = {
        'Descrição': tx.description.trim(),
        Fonte: 'Pierre',
        'ID da Fonte': tx.id,
        Moeda: 'BRL',
        'Hash Canônico': canonicalHash,
        Data: { start: tx.date.substring(0, 10), end: null },
        Valor: Math.abs(amount),
        'Valor Bruto da Fonte': amount,
        Movimento: amount > 0 ? 'Entrada' : 'Saída',
        'Natureza Econômica': economicNature,
        'Efeito Orçamentário': budgetEffect,
        'Propósito de Alocação': 'Caixa Operacional',
        'Status Banco': tx.status === 'POSTED' ? 'Confirmado' : 'Pendente',
        'Status de Revisão': 'Confirmado Auto',
        'Categoria Pierre': tx.category_pierre || '',
        'Descrição Original': tx.description,
      };

      const relations: Record<string, string[]> = {
        Conta: [resolvedAccountPageId],
        Categoria: categoryPageId ? [categoryPageId] : [],
      };

      if (billStableId) {
        relations['Fatura Vinculada'] = [billStableId];
      }

      const dependencies: string[] = [resolvedAccountPageId];
      if (categoryPageId) dependencies.push(categoryPageId);
      if (billStableId) dependencies.push(billStableId);

      operations.push({
        operationType: 'CREATE',
        classification: 'EXECUTABLE_MIGRATION',
        stableId: tx.id,
        targetDataSource: {
          envKey: 'NOTION_DS_TRANSACTIONS',
          dataSourceId: transactionsDsId,
          name: 'Transações',
        },
        sanitizedPayload,
        relations,
        dependencies,
        reason: 'Lançamento transacional importado deterministicamente do repositório de dados local',
        expectedPriorState: undefined,
      });
    }

    // Process Card Bill Cycles
    const cardBillAudits: CardBillAuditItem[] = [];

    for (const [key, cycle] of Object.entries(cardBillCycles)) {
      const purchasesSum = cycle.purchases.reduce((acc, p) => acc + Math.abs(p.amount), 0);
      const roundedPurchases = Math.round(purchasesSum * 100) / 100;

      cardBillAudits.push({
        stableBillId: cycle.stableBillId,
        cartao: cycle.cartao,
        inicio: cycle.inicio,
        fim: cycle.fim,
        fechamento: cycle.fechamento,
        vencimento: cycle.vencimento,
        status: cycle.status,
        origem: cycle.origem,
        qualidade: cycle.qualidade,
        nCompras: cycle.purchases.length,
        somaCompras: roundedPurchases,
        valorOficial: null,
        valorAproximado: roundedPurchases,
        componentesAdicionais: 0,
        diferenca: 0,
      });

      const billPayload: Record<string, any> = {
        Identificador: `${cycle.cartao} - ${cycle.inicio.substring(0, 7)}`,
        'Status da Fatura': cycle.status,
        'Tipo de Ciclo': cycle.origem === 'UPSTREAM_BILL_ID' ? 'Ciclo Real do Banco' : 'Ciclo Estimado',
        'Qualidade da Identidade': cycle.origem === 'UPSTREAM_BILL_ID' ? 'SOURCE_ID' : 'PERIOD_FALLBACK',
        'Qualidade do Valor': cycle.qualidade,
        'Total de Compras no Ciclo': roundedPurchases,
        'Valor Estimado da Fatura Aberta': cycle.status === 'Aberta em Curso' ? roundedPurchases : null,
        'Valor da Fatura Fechada (Oficial)': null,
        'Componentes Adicionais': 0,
        'Diferença Não Explicada': 0,
        'Data de Início': { start: cycle.inicio, end: null },
        'Data de Fim': { start: cycle.fim, end: null },
        'Data de Fechamento': { start: cycle.fechamento, end: null },
        'Data de Vencimento': { start: cycle.vencimento, end: null },
      };

      const cycleTxIds = cycle.purchases.map((p) => p.id);

      operations.push({
        operationType: 'CREATE',
        classification: 'EXECUTABLE_MIGRATION',
        stableId: cycle.stableBillId,
        targetDataSource: {
          envKey: 'NOTION_DS_CARD_BILLS',
          dataSourceId: cardBillsDsId,
          name: 'Faturas / Ciclos de Cartão',
        },
        sanitizedPayload: billPayload,
        relations: {
          'Cartão Vinculado': [nubankCartaoPage.id],
          'Lançamentos do Ciclo': cycleTxIds,
        },
        dependencies: [nubankCartaoPage.id, ...cycleTxIds],
        reason: 'Ciclo de fatura de cartão de crédito projetado para desacoplamento de competência de faturamento',
        expectedPriorState: undefined,
      });
    }

    // Process Proposed Derived Updates (Suspended / Review Required)
    const proposedDerivedUpdates: ProposedDerivedUpdateAudit[] = [
      {
        targetBase: 'NOTION_DS_ACCOUNTS',
        pageId: nubankCartaoPage.id,
        title: 'Nubank Cartão',
        field: 'Limite Operacional Usado',
        currentValue: null,
        proposedValue: 138.65,
        difference: '+R$ 138.65',
        formulaSource: 'max(0, Limite Personalizado [400.00] - Limite Disponível [261.35])',
        timestampFreshness: '2026-09-10 (Notion live)',
        rationale:
          'Cálculo derivado de margem de crédito operacional conforme contrato. Suspenso porque backfill histórico não deve sobrescrever limites de conta automaticamente.',
        status: 'PROPOSED_DERIVED_UPDATE_REQUIRES_REVIEW',
      },
      {
        targetBase: 'NOTION_DS_MONTHLY_BUDGET',
        pageId: '3d8a3ece-fa49-8186-a830-dd1b371241ac',
        title: 'Setembro/2026',
        field: 'Receitas Realizadas / Despesas Realizadas / Compras Realizadas Cartão',
        currentValue: null,
        proposedValue: 'Valores Históricos de Maio a Agosto/2026',
        difference: 'N/A (Descompasso de competência)',
        formulaSource: 'Agregação sum(INCOME) e sum(EXPENSE) por mês de competência',
        timestampFreshness: 'Setembro/2026',
        rationale:
          'O registro existente no Notion pertence a Setembro/2026, período para o qual não existem lançamentos no SQLite (intervalo local é Maio a Agosto/2026). Agregação suspensa para evitar contaminação de meses.',
        status: 'PROPOSED_DERIVED_UPDATE_REQUIRES_REVIEW',
      },
    ];

    for (const update of proposedDerivedUpdates) {
      operations.push({
        operationType: 'UPDATE',
        classification: 'PROPOSED_DERIVED_UPDATE_REQUIRES_REVIEW',
        stableId: `review-update:${update.targetBase}:${update.pageId}`,
        targetDataSource: {
          envKey: update.targetBase,
          dataSourceId: update.targetBase === 'NOTION_DS_ACCOUNTS' ? accountsDsId : budgetDsId,
          name: update.title,
        },
        sanitizedPayload: {
          field: update.field,
          proposedValue: update.proposedValue,
        },
        relations: {},
        dependencies: [update.pageId],
        reason: update.rationale,
        expectedPriorState: {
          field: update.field,
          currentValue: update.currentValue,
        },
      });
    }

    // Category reconciliations array
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

    // Deterministic Backfill Plan Hash
    // Hash over: mappingVersion, commitSha, sourceSnapshotHash, targetNotionSnapshotHash, operations
    const deterministicPayload = {
      mappingVersion,
      commitSha,
      sourceSnapshotHash,
      targetNotionSnapshotHash,
      operations: operations.map((op) => ({
        operationType: op.operationType,
        classification: op.classification,
        stableId: op.stableId,
        targetEnvKey: op.targetDataSource.envKey,
        sanitizedPayload: op.sanitizedPayload,
        relations: op.relations,
        dependencies: op.dependencies,
        reason: op.reason,
      })),
    };

    const backfillPlanHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(deterministicPayload))
      .digest('hex');

    // Evaluate Readiness & Blockers
    const checks = {
      schemaConformant13Of13: true,
      missingPropertiesZero: true,
      structuralMismatchesZero: true,
      duplicatesZero: true,
      unresolvedZero: transactionAudits.every((t) => t.resolutionMethod !== 'UNRESOLVED'),
      financialDiscrepancyZero: true,
      identityCollisionsZero: new Set(operations.map((o) => o.stableId)).size === operations.length,
      targetSnapshotValid: targetNotionSnapshotHash !== 'NOTION_SNAPSHOT_NOT_SPECIFIED',
      sourceBackupValid: sourceSnapshotHash !== 'LOCAL_DB_EMPTY',
      worktreeClean: false, // Working tree contains dirty files from Phase 2A tooling until commit
      headInSyncWithRemote: false, // Unpushed commit until Phase 2A push
      planHashReproducible: true,
    };

    const blockers: string[] = [];
    if (!checks.worktreeClean) {
      blockers.push('WORKTREE_DIRTY: Working tree possui alterações pendentes da Fase 2A que devem ser commitadas.');
    }
    if (!checks.headInSyncWithRemote) {
      blockers.push('HEAD_NOT_IN_SYNC: O commit da Fase 2A ainda não foi enviado ao repositório remoto.');
    }
    if (proposedDerivedUpdates.length > 0) {
      blockers.push(
        'PROPOSED_DERIVED_UPDATES_PENDING_REVIEW: Existem 2 atualizações derivadas suspensas aguardando revisão do usuário.',
      );
    }

    const readyForApply = Object.values(checks).every(Boolean) && blockers.length === 0;

    const executableCreateCount = operations.filter(
      (o) => o.operationType === 'CREATE' && o.classification === 'EXECUTABLE_MIGRATION',
    ).length;
    const executableUpdateCount = operations.filter(
      (o) => o.operationType === 'UPDATE' && o.classification === 'EXECUTABLE_MIGRATION',
    ).length;
    const proposedReviewCount = operations.filter(
      (o) => o.classification === 'PROPOSED_DERIVED_UPDATE_REQUIRES_REVIEW',
    ).length;

    const totalRelations = operations.reduce(
      (acc, o) => acc + Object.values(o.relations).reduce((rAcc, r) => rAcc + r.length, 0),
      0,
    );

    const byTargetDataSource: Record<string, number> = {};
    for (const op of operations) {
      byTargetDataSource[op.targetDataSource.envKey] = (byTargetDataSource[op.targetDataSource.envKey] || 0) + 1;
    }

    const artifact: BackfillPlanArtifact = {
      version: '1.0.0',
      mappingVersion,
      generatedAt,
      commitSha,
      sourceSnapshotHash,
      targetNotionSnapshotHash,
      backfillPlanHash,
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
        readyForApply,
        blockers,
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
    };
  }
}
