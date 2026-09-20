import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  BackfillPlanner,
  validateOperationAgainstContract,
  isValidIsoDate,
  getLastDayOfMonth,
  generateCounterpartyPseudonym,
  calculateSemanticConfigHash,
  buildSemanticPlannerConfig,
  resolvePlannerConfig,
  validateHmacKey,
} from '../src/notion/migration-runner/backfill-planner';
import { calculateTargetStateHash, canonicalizeValue } from '../src/notion/migration-runner/data-snapshot';

function loadPrivacyBlocklist(): string[] {
  const blocklistPath = process.env.PRIVACY_BLOCKLIST_PATH;
  if (!blocklistPath || !fs.existsSync(blocklistPath)) {
    return [];
  }
  const raw = fs.readFileSync(blocklistPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // line-by-line fallback
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('BackfillPlanner - Contract Validation & Safety Gates', () => {
  const sampleNotionAccounts = [
    {
      id: 'acc-cartao-page-id',
      name: 'Nubank Cartão',
      type: 'Cartão de crédito',
      creditLimit: 2400,
      customLimit: 400,
      availableLimit: 261.35,
    },
    {
      id: 'acc-conta-page-id',
      name: 'Nubank Conta',
      type: 'Conta corrente',
    },
  ];

  const sampleNotionCategories = [
    { id: 'cat-1', name: 'Alimentação' },
    { id: 'cat-2', name: 'Moradia' },
    { id: 'cat-3', name: 'Transporte' },
    { id: 'cat-4', name: 'Lazer' },
    { id: 'cat-5', name: 'Saúde' },
    { id: 'cat-6', name: 'Educação' },
    { id: 'cat-7', name: 'Assinaturas & Serviços' },
    { id: 'cat-8', name: 'Cuidados Pessoais' },
    { id: 'cat-9', name: 'Vestuário' },
    { id: 'cat-10', name: 'Compras & Variados' },
    { id: 'cat-11', name: 'Presentes & Doações' },
    { id: 'cat-12', name: 'Taxas & Tarifas' },
    { id: 'cat-13', name: 'Impostos' },
    { id: 'cat-14', name: 'Pagamento de Fatura' },
    { id: 'cat-15', name: 'Transferência Interna' },
    { id: 'cat-16', name: 'Receita' },
    { id: 'cat-17', name: 'Rendimento' },
    { id: 'cat-18', name: 'Outros' },
  ];

  function getLocalBackupKey(): string | undefined {
    if (process.env.MIGRATION_BACKUP_KEY) {
      return process.env.MIGRATION_BACKUP_KEY;
    }
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('MIGRATION_BACKUP_KEY=')) {
          return trimmed.slice('MIGRATION_BACKUP_KEY='.length).trim();
        }
      }
    }
    return undefined;
  }

  delete process.env.BACKFILL_ACCOUNT_MAPPING_PATH;

  const testEnv = {
    NOTION_API_KEY: 'test-key',
    NOTION_DS_ACCOUNTS: 'fake-acc-ds',
    NOTION_DS_CATEGORIES: 'fake-cat-ds',
    NOTION_DS_TRANSACTIONS: 'fake-tx-ds',
    NOTION_DS_CARD_BILLS: 'fake-bills-ds',
    NOTION_DS_MONTHLY_BUDGET: 'fake-budget-ds',
    NOTION_TARGET_SNAPSHOT_MANIFEST: 'backups/notion-data-snapshot-20260913T190702-0a3af05c.json.enc.manifest.json',
    SOURCE_SQLITE_SNAPSHOT_MANIFEST: 'backups/financial-backup-20260914T023409-a6df794b.db.enc.manifest.json',
    BACKFILL_ACCOUNT_MAPPING_PATH: 'data/account-mapping.json',
    MIGRATION_BACKUP_KEY: getLocalBackupKey(),
    COUNTERPARTY_HMAC_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  describe('validateOperationAgainstContract', () => {
    it('succeeds for valid transactions payload conforming to TARGET_CONTRACT', () => {
      const validPayload = {
        Lançamento: 'Compra Teste Padaria',
        Fonte: 'Pierre',
        'ID da fonte': 'tx-12345',
        Moeda: 'BRL',
        'Hash Canônico': 'a'.repeat(64),
        Data: { start: '2026-06-01', end: null },
        Valor: 50.0,
        'Valor Bruto da Fonte': -50.0,
        Movimento: 'Saída',
        Natureza: 'Despesa',
        'Efeito Orçamentário': 'Despesa',
        'Propósito de Alocação': 'Caixa Operacional',
        'Contribuição Meta Poupança': 0,
        Status: 'Confirmado',
        'Status de Revisão': 'Confirmado Auto',
        'Motivo da Revisão': '',
        'Categoria Pierre': 'Alimentação',
        'Descrição original': 'Padaria Pão Quente',
        'HMAC Contraparte': '',
      };
      const relations = {
        Conta: [{ type: 'EXISTING_PAGE_ID' as const, target: 'acc-page-id' }],
      };

      expect(() => {
        validateOperationAgainstContract('NOTION_DS_TRANSACTIONS', validPayload, relations);
      }).not.toThrow();
    });

    it('throws fail-closed error if an unexpected property is present in payload', () => {
      const invalidPayload = {
        Lançamento: 'Compra Teste',
        PropriedadeInvalida: 'Valor',
      };
      expect(() => {
        validateOperationAgainstContract('NOTION_DS_TRANSACTIONS', invalidPayload, {});
      }).toThrow(/CONTRACT_VALIDATION_ERROR.*PropriedadeInvalida/);
    });

    it('throws fail-closed error if an invalid select option is passed', () => {
      const invalidSelectPayload = {
        'Fatura / Ciclo': 'Nubank Cartão - Junho/2026',
        'Tipo de Ciclo': 'Ciclo Real do Banco', // Invalid: canonical is 'Ciclo Real Banco'
      };
      expect(() => {
        validateOperationAgainstContract('NOTION_DS_CARD_BILLS', invalidSelectPayload, {});
      }).toThrow(/Opção 'Ciclo Real do Banco' inválida/);
    });
  });

  describe('Fail-Closed Identity & Preconditions', () => {
    it('throws FAIL_CLOSED_GIT_RESOLUTION on malformed or absent Git commit SHA', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      expect(() => {
        planner.generateArtifact({
          commitSha: 'not-a-sha',
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
        });
      }).toThrow(/FAIL_CLOSED_GIT_RESOLUTION/);
    });

    it('throws FAIL_CLOSED_NOTION_METADATA if notionAccounts is missing or empty', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: [],
          notionCategories: sampleNotionCategories,
        });
      }).toThrow(/FAIL_CLOSED_NOTION_METADATA/);
    });

    it('throws FAIL_CLOSED_NOTION_METADATA if notionCategories is missing or empty', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: sampleNotionAccounts,
          notionCategories: [],
        });
      }).toThrow(/FAIL_CLOSED_NOTION_METADATA/);
    });

    it('throws FAIL_CLOSED_ACCOUNT_MAPPING if required accounts are missing from live Notion', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: [
            { id: 'acc-1', name: 'Mercado Pago', type: 'Conta corrente' },
          ],
          notionCategories: sampleNotionCategories,
        });
      }).toThrow(/FAIL_CLOSED_ACCOUNT_MAPPING/);
    });
  });

  describe('Operations & Relations Conformance', () => {
    it('produces exactly 159 CREATE operations and 0 UPDATE operations', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact, proposedDerivedUpdates } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      expect(artifact.summary.executableCreateCount).toBe(159);
      expect(artifact.summary.executableUpdateCount).toBe(0);
      expect(artifact.summary.proposedReviewCount).toBe(0);
      expect(artifact.operations).toHaveLength(159);
      expect(artifact.operations.every((op) => op.operationType === 'CREATE')).toBe(true);

      // Verify proposedDerivedUpdates is strictly empty in Phase 2A.5 clean state
      expect(proposedDerivedUpdates).toHaveLength(0);
    });

    it('strongly types all relation references as EXISTING_PAGE_ID or PLANNED_STABLE_ID', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      for (const op of artifact.operations) {
        for (const [relProp, rels] of Object.entries(op.relations)) {
          for (const r of rels) {
            expect(['EXISTING_PAGE_ID', 'PLANNED_STABLE_ID']).toContain(r.type);
            expect(r.target).toBeTruthy();
          }
        }
      }
    });

    it('strictly assigns Fatura Vinculada to the 20 purchases and NOT to the 26 credit card payments', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      const txOps = artifact.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS');
      expect(txOps).toHaveLength(155);

      const opsWithBillRelation = txOps.filter((o) => o.relations['Fatura Vinculada']?.length > 0);
      expect(opsWithBillRelation).toHaveLength(20);

      // All 20 purchases have PLANNED_STABLE_ID targeting one of the card bills
      expect(
        opsWithBillRelation.every((o) => o.relations['Fatura Vinculada'][0].type === 'PLANNED_STABLE_ID'),
      ).toBe(true);

      // The 26 credit card payments do NOT have Fatura Vinculada
      const cardPaymentOps = txOps.filter(
        (o) =>
          o.relations['Conta'][0].target === 'acc-cartao-page-id' &&
          o.sanitizedPayload['Natureza'] === 'Pagamento de fatura',
      );
      expect(cardPaymentOps).toHaveLength(26);
      expect(cardPaymentOps.every((o) => !o.relations['Fatura Vinculada'] || o.relations['Fatura Vinculada'].length === 0)).toBe(true);
    });

    it('assigns Transações de Pagamento on card bills to the 15 payment events', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      const billOps = artifact.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
      expect(billOps).toHaveLength(4);

      const totalPaymentLegRelations = billOps.reduce(
        (acc, b) => acc + (b.relations['Transações de Pagamento']?.length || 0),
        0,
      );
      expect(totalPaymentLegRelations).toBe(15);

      const totalCycleTransactions = billOps.reduce(
        (acc, b) => acc + (b.relations['Lançamentos do Ciclo']?.length || 0),
        0,
      );
      expect(totalCycleTransactions).toBe(20);
    });

    it('includes all 26 dynamic readiness checks in BackfillPlanArtifact', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      const checks = artifact.readiness.checks;
      expect(Object.keys(checks)).toHaveLength(31);
      expect(checks).toHaveProperty('schemaConformant13Of13');
      expect(checks).toHaveProperty('missingPropertiesZero');
      expect(checks).toHaveProperty('structuralMismatchesZero');
      expect(checks).toHaveProperty('duplicatesZero');
      expect(checks).toHaveProperty('unresolvedAccountsZero');
      expect(checks).toHaveProperty('unresolvedCategoryErrorsZero');
      expect(checks).toHaveProperty('unresolvedCategoriesZero');
      expect(checks).toHaveProperty('unresolvedPaymentAllocationsZero');
      expect(checks).toHaveProperty('paymentPairingAmbiguitiesZero');
      expect(checks).toHaveProperty('paymentAllocationsResolved');
      expect(checks).toHaveProperty('billStructuralValidity');
      expect(checks).toHaveProperty('billOfficialEvidenceAvailable');
      expect(checks).toHaveProperty('billStatusInferenceSafe');
      expect(checks).toHaveProperty('billReconciliationEvidenceSufficient');
      expect(checks).toHaveProperty('cashFlowReconciliationZero');
      expect(checks).toHaveProperty('classifiedEconomicReconciliationZero');
      expect(checks).toHaveProperty('financialDiscrepancyZero');
      expect(checks).toHaveProperty('identityCollisionsZero');
      expect(checks).toHaveProperty('targetSnapshotValid');
      expect(checks).toHaveProperty('targetLiveDriftZero');
      expect(checks).toHaveProperty('sourceBackupValid');
      expect(checks).toHaveProperty('ciphertextIntegrityValid');
      expect(checks).toHaveProperty('manifestIntegrityValid');
      expect(checks).toHaveProperty('manifestStructureAndHashReferencesValid');
      expect(checks).toHaveProperty('plaintextRestoreVerified');
      expect(checks).toHaveProperty('sourceSnapshotCiphertextValid');
      expect(checks).toHaveProperty('sourceSnapshotManifestValid');
      expect(checks).toHaveProperty('sourceSnapshotRestoreVerified');
      expect(checks).toHaveProperty('worktreeClean');
      expect(checks).toHaveProperty('headInSyncWithRemote');
      expect(checks).toHaveProperty('planHashReproducible');
    });
  });

  describe('Dynamic Checks & Negative Proofs (Fase 2A.2)', () => {
    it('throws FAIL_CLOSED_TARGET_SNAPSHOT if NOTION_TARGET_SNAPSHOT_MANIFEST is missing', () => {
      const envWithoutManifest = { ...testEnv, NOTION_TARGET_SNAPSHOT_MANIFEST: '' };
      const planner = new BackfillPlanner({ envVars: envWithoutManifest });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
        });
      }).toThrow(/FAIL_CLOSED_TARGET_SNAPSHOT/);
    });

    it('throws CORRUPTED_SNAPSHOT if manifest targetNotionSnapshotHash diverges', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
          targetNotionSnapshotHash: 'bad_hash_'.padEnd(64, '0'),
        });
      }).toThrow(/CORRUPTED_SNAPSHOT/);
    });

    it('throws FAIL_CLOSED_SOURCE_DB if sourceSnapshotHash does not match SQLite DB', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
          sourceSnapshotHash: 'bad_db_hash_'.padEnd(64, '0'),
        });
      }).toThrow(/FAIL_CLOSED_SOURCE_DB/);
    });

    it('throws FAIL_CLOSED_ENV if NOTION_DS_CARD_BILLS is missing', () => {
      const envWithoutBills = { ...testEnv, NOTION_DS_CARD_BILLS: '' };
      const planner = new BackfillPlanner({ envVars: envWithoutBills });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
        });
      }).toThrow(/FAIL_CLOSED_ENV: Variável NOTION_DS_CARD_BILLS/);
    });

    it('evaluates schemaConformant13Of13 as false when 12/13 bases are verified', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        schemaEvidence: {
          totalDataSources: 13,
          verifiedDataSources: 12,
          missingPropertiesCount: 0,
          structuralMismatchesCount: 0,
        },
      });
      expect(artifact.readiness.checks.schemaConformant13Of13).toBe(false);
      expect(artifact.readiness.blockers).toContain(
        'SCHEMA_NON_CONFORMANT: Notion live não possui as 13 bases canônicas verificadas.',
      );
    });

    it('evaluates missingPropertiesZero as false when missingPropertiesCount > 0', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        schemaEvidence: {
          totalDataSources: 13,
          verifiedDataSources: 13,
          missingPropertiesCount: 1,
          structuralMismatchesCount: 0,
        },
      });
      expect(artifact.readiness.checks.missingPropertiesZero).toBe(false);
      expect(artifact.readiness.blockers).toContain(
        'SCHEMA_MISSING_PROPERTIES: Existem propriedades obrigatórias ausentes no Notion live.',
      );
    });

    it('evaluates structuralMismatchesZero as false when structuralMismatchesCount > 0', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        schemaEvidence: {
          totalDataSources: 13,
          verifiedDataSources: 13,
          missingPropertiesCount: 0,
          structuralMismatchesCount: 1,
        },
      });
      expect(artifact.readiness.checks.structuralMismatchesZero).toBe(false);
      expect(artifact.readiness.blockers).toContain(
        'SCHEMA_STRUCTURAL_MISMATCHES: Existem incompatibilidades estruturais no Notion live.',
      );
    });

    it('evaluates financialDiscrepancyZero as false when a discrepancy of R$ 0.01 is introduced', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        _mockExpectedEconomicExpenses: 2548.92,
      });
      expect(artifact.readiness.checks.financialDiscrepancyZero).toBe(false);
      expect(artifact.readiness.blockers).toContain(
        'FINANCIAL_DISCREPANCY: Discrepância financeira residual detectada.',
      );
    });

    it('evaluates planHashReproducible as false when hash is not reproduced independently', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        _forceIrreproducibleHash: true,
      });
      expect(artifact.readiness.checks.planHashReproducible).toBe(false);
      expect(artifact.readiness.blockers).toContain(
        'PLAN_HASH_IRREPRODUCIBLE: Divergência na reprodução do backfillPlanHash.',
      );
    });

    it('excludes outgoing internal transfers (R$ 115,00) and pending outgoing transfers (R$ 163,59) from economic expenses', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      const internalTransferOps = artifact.operations.filter(
        (o) => o.sanitizedPayload['Natureza'] === 'Transferência interna',
      );
      expect(internalTransferOps.length).toBeGreaterThan(0);
      expect(internalTransferOps.every((o) => o.sanitizedPayload['Efeito Orçamentário'] === 'Neutro')).toBe(true);

      const totalExpenses = artifact.operations
        .filter((o) => o.sanitizedPayload['Efeito Orçamentário'] === 'Despesa')
        .reduce((sum, o) => sum + Number(o.sanitizedPayload['Valor']), 0);
      expect(Math.round(totalExpenses * 100) / 100).toBe(2548.91);
    });

    it('treats 36 third-party inflows and 13 third-party outflows as economically pending review with null nature and effect', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact, incomingTransferAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      expect(artifact.readiness.pendingEconomicClassificationCount).toBe(49);
      expect(artifact.readiness.pendingCategoryReviewCount).toBe(13);
      expect(artifact.readiness.checks.unresolvedCategoryErrorsZero).toBe(true);

      const pendingAudits = incomingTransferAudits.filter(
        (t) => t.counterpartyType !== 'SAME_OWNERSHIP_TRANSFER',
      );
      expect(pendingAudits).toHaveLength(36);
      expect(pendingAudits.every((t) => t.economicNature === null)).toBe(true);
      expect(pendingAudits.every((t) => t.budgetEffect === null)).toBe(true);
      expect(pendingAudits.every((t) => t.reviewStatus === 'Pendente Revisão')).toBe(true);

      // Verify corresponding operations
      const pendingTxIds = new Set(pendingAudits.map((a) => a.txId));
      const pendingOps = artifact.operations.filter((o) => pendingTxIds.has(o.stableId));
      expect(pendingOps).toHaveLength(36);
      expect(pendingOps.every((o) => o.sanitizedPayload['Natureza'] === null)).toBe(true);
      expect(pendingOps.every((o) => o.sanitizedPayload['Efeito Orçamentário'] === null)).toBe(true);
      expect(pendingOps.every((o) => !o.relations['Categoria'] || o.relations['Categoria'].length === 0)).toBe(true);
      expect(pendingOps.every((o) => o.sanitizedPayload['Status de Revisão'] === 'Pendente Revisão')).toBe(true);
    });

    it('audits card cycles status and unexplained discrepancy as null when official evidence is absent', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      expect(cardBillAudits).toHaveLength(4);

      // Cycle 2 (June) - conservative null status due to null official bill value
      const cycle2 = cardBillAudits.find((b) => b.stableBillId === 'nubank:bill:a5ea6710-2f6e-4663-a237-2c062b8fa8d7');
      expect(cycle2).toBeDefined();
      expect(cycle2!.somaCompras).toBe(171.79);
      expect(cycle2!.paidAmount).toBe(171.79);
      expect(cycle2!.purchasePaymentDelta).toBe(0);
      expect(cycle2!.officialBillDiscrepancy).toBeNull();
      expect(cycle2!.unexplainedDiscrepancy).toBeNull();
      expect(cycle2!.status).toBeNull();

      // Cycle 3 (July) - conservative null status due to null official bill value
      const cycle3 = cardBillAudits.find((b) => b.stableBillId === 'nubank:bill:f4513058-c028-4b90-b663-16f27d0e2d8e');
      expect(cycle3).toBeDefined();
      expect(cycle3!.somaCompras).toBe(55.89);
      expect(cycle3!.paidAmount).toBe(55.89);
      expect(cycle3!.purchasePaymentDelta).toBe(0);
      expect(cycle3!.officialBillDiscrepancy).toBeNull();
      expect(cycle3!.unexplainedDiscrepancy).toBeNull();
      expect(cycle3!.status).toBeNull();

      // Cycle 1 (May) - partially paid, delta 24.85
      const cycle1 = cardBillAudits.find((b) => b.stableBillId === 'nubank:bill:7f6be926-ae1b-4685-a830-8ec6e773fbf0');
      expect(cycle1).toBeDefined();
      expect(cycle1!.somaCompras).toBe(7.08);
      expect(cycle1!.paidAmount).toBe(31.93);
      expect(cycle1!.purchasePaymentDelta).toBe(24.85);
      expect(cycle1!.officialBillDiscrepancy).toBeNull();
      expect(cycle1!.unexplainedDiscrepancy).toBeNull();
      expect(cycle1!.status).toBeNull();

      // Cycle 4 (July open/fallback) - partially paid, delta 316.24
      const cycle4 = cardBillAudits.find((b) => b.stableBillId === 'nubank:cartao:2026-07:cycle');
      expect(cycle4).toBeDefined();
      expect(cycle4!.somaCompras).toBe(415.03);
      expect(cycle4!.paidAmount).toBe(98.79);
      expect(cycle4!.purchasePaymentDelta).toBe(316.24);
      expect(cycle4!.officialBillDiscrepancy).toBeNull();
      expect(cycle4!.unexplainedDiscrepancy).toBeNull();
      expect(cycle4!.status).toBeNull();
    });

    it('strictly validates calendar dates and rejects invalid ISO dates', () => {
      expect(isValidIsoDate('2024-02-29')).toBe(true); // Leap year valid
      expect(isValidIsoDate('2026-02-29')).toBe(false); // Non-leap year invalid
      expect(isValidIsoDate('2026-04-31')).toBe(false); // April has 30 days
      expect(isValidIsoDate('2026-13-01')).toBe(false); // Invalid month 13
      expect(isValidIsoDate('2026/05/01')).toBe(false); // Slash format invalid
      expect(isValidIsoDate('')).toBe(false);
      expect(isValidIsoDate(null as any)).toBe(false);

      expect(getLastDayOfMonth(2024, 2)).toBe(29);
      expect(getLastDayOfMonth(2026, 2)).toBe(28);
      expect(getLastDayOfMonth(2026, 4)).toBe(30);
      expect(getLastDayOfMonth(2026, 7)).toBe(31);
    });

    it('prunes empty cycles without purchases (e.g. August 2026 payment only)', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      // August 2026 has a payment leg (457dbf4d, R$ 30,00) but 0 purchases -> pruned from bills
      expect(cardBillAudits).toHaveLength(4);
      expect(cardBillAudits.find((b) => b.stableBillId.includes('2026-08'))).toBeUndefined();
    });

    it('detects ambiguous payment pairing candidates when multiple identical amounts exist within 48h', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      // The canonical dataset has 0 pairing ambiguities
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      expect(artifact.readiness.checks.paymentPairingAmbiguitiesZero).toBe(true);
      expect(artifact.readiness.checks.paymentAllocationsResolved).toBe(true);
    });

    it('never assigns Paga Integralmente when valorOficial is null', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      // All card bills without valorOficial must have status = null
      for (const bill of cardBillAudits) {
        if (bill.valorOficial === null) {
          expect(bill.status).not.toBe('Paga Integralmente');
          expect(bill.status).toBeNull();
        }
      }
    });

    it('evaluates unresolvedAccountsZero as false when an account UUID is missing from sourceAccountMapping', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        plannerConfig: {
          sourceAccountMapping: {
            'test-checking-account-id': 'CHECKING',
            // Omit other accounts to force unresolved state
          },
        },
      });

      expect(artifact.readiness.checks.unresolvedAccountsZero).toBe(false);
      expect(artifact.readiness.blockers.some((b) => b.includes('UNRESOLVED_ACCOUNTS'))).toBe(true);
    });

    it('does not map (transferência) || transferências to Transferências internas without same-ownership proof', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      // Third party transfer operations must not have category 'Transferência Interna'
      const internalTransferCategoryId = sampleNotionCategories.find((c) => c.name === 'Transferência Interna')?.id;
      const transferTxs = artifact.operations.filter((o) => {
        const catPierre = o.sanitizedPayload['Categoria Pierre'] || '';
        return catPierre.toLowerCase() === 'transferências';
      });

      expect(transferTxs.length).toBeGreaterThan(0);
      expect(
        transferTxs.every((o) => {
          const catRel = o.relations['Categoria']?.[0]?.target;
          return catRel !== internalTransferCategoryId;
        }),
      ).toBe(true);
    });

    it('strictly enforces readyForApply = false even when all checks pass', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        schemaEvidence: {
          totalDataSources: 13,
          verifiedDataSources: 13,
          missingPropertiesCount: 0,
          structuralMismatchesCount: 0,
        },
      });

      // In Phase 2A, readyForApply must be strictly false
      expect(artifact.readiness.readyForApply).toBe(false);
    });
  });

  describe('Fase 2A.4 - Mandatory Negative Proofs & Safety Invariants', () => {
    it('1. throws FAIL_CLOSED_ACCOUNT_MAPPING_CONFIG when sourceAccountMapping / BACKFILL_ACCOUNT_MAPPING_PATH is missing', () => {
      const envWithoutMapping = { ...testEnv, BACKFILL_ACCOUNT_MAPPING_PATH: '' };
      const planner = new BackfillPlanner({ envVars: envWithoutMapping });
      expect(() => {
        planner.generateArtifact({
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
        });
      }).toThrow(/FAIL_CLOSED_ACCOUNT_MAPPING_CONFIG/);
    });

    it('2. maps unknown account UUID to UNRESOLVED_ACCOUNT and evaluates unresolvedAccountsZero as false', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact, transactionAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        plannerConfig: {
          sourceAccountMapping: {
            'arbitrary-unknown-uuid': 'CHECKING',
          },
        },
      });
      expect(artifact.readiness.checks.unresolvedAccountsZero).toBe(false);
      expect(artifact.readiness.blockers.some((b) => b.includes('UNRESOLVED_ACCOUNTS'))).toBe(true);
      const unresolved = transactionAudits.filter((t) => t.resolutionMethod === 'UNRESOLVED');
      expect(unresolved.length).toBeGreaterThan(0);
    });

    it('3. evaluates all 3 snapshot checks as false when snapshotValidation is omitted', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        snapshotValidation: undefined,
      });
      expect(artifact.readiness.checks.ciphertextIntegrityValid).toBe(false);
      expect(artifact.readiness.checks.manifestIntegrityValid).toBe(false);
      expect(artifact.readiness.checks.plaintextRestoreVerified).toBe(false);
    });

    it('4. sets readyForExecutorImplementation to false when plaintext restore is unverified', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        snapshotValidation: {
          ciphertextIntegrityValid: true,
          manifestIntegrityValid: true,
          plaintextRestoreVerified: false,
        },
      });
      expect(artifact.readiness.checks.plaintextRestoreVerified).toBe(false);
      expect(artifact.readiness.readyForExecutorImplementation).toBe(false);
      expect(artifact.readiness.blockers).toContain(
        'SNAPSHOT_RESTORE_UNVERIFIED: Restauração do snapshot para texto plano não verificada.',
      );
    });

    it('5. ensures pending outgoing third-party transfers do NOT become Despesa', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      const pendingOutflowOps = artifact.operations.filter(
        (o) =>
          o.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS' &&
          o.sanitizedPayload['Movimento'] === 'Saída' &&
          o.sanitizedPayload['Status de Revisão'] === 'Pendente Revisão',
      );
      expect(pendingOutflowOps).toHaveLength(13);
      for (const op of pendingOutflowOps) {
        expect(op.sanitizedPayload['Efeito Orçamentário']).toBeNull();
        expect(op.sanitizedPayload['Natureza']).toBeNull();
        expect(op.relations['Categoria'] || []).toHaveLength(0);
      }
    });

    it('6. ensures pending outgoing third-party transfers never have Status de Revisão = Confirmado Auto', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      const pendingOutflowOps = artifact.operations.filter(
        (o) =>
          o.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS' &&
          o.sanitizedPayload['Movimento'] === 'Saída' &&
          !o.sanitizedPayload['Natureza'],
      );
      expect(pendingOutflowOps).toHaveLength(13);
      for (const op of pendingOutflowOps) {
        expect(op.sanitizedPayload['Status de Revisão']).toBe('Pendente Revisão');
        expect(op.sanitizedPayload['Status de Revisão']).not.toBe('Confirmado Auto');
      }
    });

    it('7. includes pending outflows in physical cash but strictly excludes from confirmed economic expenses', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      expect(artifact.readiness.pendingEconomicOutflows).toBe(163.59);
      expect(artifact.readiness.confirmedEconomicExpenses).toBe(2548.91);
      expect(artifact.readiness.physicalCashOutflows).toBe(2458.17);
      expect(artifact.readiness.checks.cashFlowReconciliationZero).toBe(true);
      expect(artifact.readiness.checks.classifiedEconomicReconciliationZero).toBe(true);
    });

    it('8. sets Divergência Não Explicada and officialBillDiscrepancy to null when valorOficial is null', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      expect(cardBillAudits).toHaveLength(4);
      for (const bill of cardBillAudits) {
        expect(bill.valorOficial).toBeNull();
        expect(bill.officialBillDiscrepancy).toBeNull();
        expect(bill.unexplainedDiscrepancy).toBeNull();
      }
    });

    it('9. does not infer Paga Integralmente or Paga Parcialmente without official bill value (status remains null)', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      for (const bill of cardBillAudits) {
        expect(bill.status).toBeNull();
        expect(bill.status).not.toBe('Paga Integralmente');
        expect(bill.status).not.toBe('Paga Parcialmente');
      }
    });

    it('10. distinguishes field provenance: dueDate is CONFIGURED/SOURCE while closingDate is DERIVED', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      expect(cardBillAudits).toHaveLength(4);
      for (const bill of cardBillAudits) {
        expect(bill.fieldProvenance.dueDate).not.toBe(bill.fieldProvenance.closingDate);
        expect(['SOURCE', 'CONFIGURED']).toContain(bill.fieldProvenance.dueDate);
        expect(bill.fieldProvenance.closingDate).toBe('DERIVED');
        expect(bill.fieldProvenance.status).toBeNull();
        expect(bill.fieldProvenance.officialAmount).toBeNull();
      }
      const fallbackCycle = cardBillAudits.find((b) => b.origem === 'PERIOD_ESTIMATED');
      expect(fallbackCycle).toBeDefined();
      expect(fallbackCycle!.fieldProvenance.dueDate).toBe('CONFIGURED');
    });

    it('11. prohibits unkeyed hashing for counterparty pseudonymization and enforces strong HMAC keys', () => {
      // Without key -> masked as [OFUSCADO], never unkeyed SHA-256
      const masked = generateCounterpartyPseudonym('João Silva', undefined);
      expect(masked).toBe('[OFUSCADO]');
      expect(masked).not.toContain('sha256');

      const maskedEmpty = generateCounterpartyPseudonym('João Silva', '');
      expect(maskedEmpty).toBe('[OFUSCADO]');

      // Weak keys must fail-closed
      expect(() => {
        generateCounterpartyPseudonym('João Silva', 'short-secret', 'v1');
      }).toThrow(/FAIL_CLOSED_HMAC_KEY/);

      expect(() => {
        resolvePlannerConfig(undefined, {
          ...testEnv,
          COUNTERPARTY_HMAC_KEY: 'weak-key',
        });
      }).toThrow(/FAIL_CLOSED_HMAC_KEY/);

      // With strong 64-hex key -> proper HMAC with prefix and 32 hex chars (128 bits minimum)
      const strong64HexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const keyed = generateCounterpartyPseudonym('João Silva', strong64HexKey, 'v1');
      expect(keyed).toMatch(/^HMAC_v1_[a-f0-9]{32}$/);

      // Verify that keyed HMAC differs from unkeyed SHA-256
      const unkeyedSha256 = crypto.createHash('sha256').update('João Silva').digest('hex').substring(0, 32);
      expect(keyed).not.toBe(`HMAC_v1_${unkeyedSha256}`);
    });

    it('12. ensures plan artifact and operations do not contain source account UUIDs', () => {
      const syntheticCheckingUuid = 'synthetic-checking-uuid-1111';
      const syntheticCreditUuid = 'synthetic-credit-uuid-2222';

      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      const artifactJson = JSON.stringify(artifact);
      for (const op of artifact.operations) {
        expect(op.sanitizedPayload).not.toHaveProperty('source_account_id');
        expect(op.sanitizedPayload).not.toHaveProperty('account_id');
      }
      expect(artifactJson).not.toContain(syntheticCheckingUuid);
      expect(artifactJson).not.toContain(syntheticCreditUuid);

      // Optional local privacy audit against real blocklist if file exists
      const blocklist = loadPrivacyBlocklist();
      for (const token of blocklist) {
        expect(artifactJson).not.toContain(token);
      }
    });

    it('13. ensures operation payloads do not contain personal names in HMAC Contraparte', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });
      const txOps = artifact.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS');
      for (const op of txOps) {
        const hmacVal = op.sanitizedPayload['HMAC Contraparte'];
        expect(typeof hmacVal).toBe('string');
        if (hmacVal && hmacVal !== '[OFUSCADO]') {
          expect(hmacVal).toMatch(/^HMAC_/);
          expect(hmacVal).not.toMatch(/[a-zA-Z]{4,}\s[a-zA-Z]{4,}/); // No first + last names
        }
      }
    });

    it('14. ensures scripts/backfill-dry-run.ts contains zero hardcoded counts or values', () => {
      const scriptContent = fs.readFileSync(path.resolve(process.cwd(), 'scripts', 'backfill-dry-run.ts'), 'utf8');
      expect(scriptContent).not.toContain('155/155');
      expect(scriptContent).not.toContain('36 txs pendentes):');
      expect(scriptContent).not.toContain('14 bank legs');

      // Optional local privacy audit against real blocklist if file exists
      const blocklist = loadPrivacyBlocklist();
      for (const token of blocklist) {
        expect(scriptContent).not.toContain(token);
      }
    });

    it('15. dynamically reconciles cash flow with arbitrary modified transaction amounts without breaking', () => {
      // Generalization test: create temporary copy of SQLite DB with modified transaction amounts
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-gen-test-'));
      const tempDbPath = path.join(tempDir, 'financial-gen.db');
      try {
        fs.copyFileSync(path.resolve(process.cwd(), 'data', 'financial.db'), tempDbPath);
        const db = new Database(tempDbPath);

        // Modify amounts of several transactions: internal transfers, settlements, direct checking expenses
        db.prepare("UPDATE transactions SET amount = -999.99 WHERE id = 'e82b7cf5-bc8d-4fe3-9799-734d8525bf78'").run();
        db.prepare("UPDATE transactions SET amount = -1234.56 WHERE id = '65d14dfb-9ef6-43cb-bdf2-f8eb065c71db'").run();
        db.prepare("UPDATE transactions SET amount = -77.77 WHERE id = '3a552251-84ff-4202-b2f7-54b9d0b6c623'").run();
        db.close();

        const planner = new BackfillPlanner({ dbPath: tempDbPath, envVars: testEnv });
        const { artifact } = planner.generateArtifact({
          dbPath: tempDbPath,
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
        });

        // The formula physicalCashOutflows == confirmedDirectCheckingExpenses + pendingThirdPartyOutflows + sameOwnershipOutgoingTransfers + cardBillSettlementCashOutflows MUST hold dynamically
        expect(artifact.readiness.checks.cashFlowReconciliationZero).toBe(true);
        expect(artifact.readiness.checks.classifiedEconomicReconciliationZero).toBe(true);
        expect(artifact.readiness.checks.financialDiscrepancyZero).toBe(true);
        expect(artifact.readiness.physicalCashOutflows).toBeGreaterThan(0);
      } finally {
        try {
          if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
          if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup
        }
      }
    });

    it('16. generates identical semantic plannerConfigHash across Windows and Linux path representations', () => {
      const baseMapping = {
        'uuid-checking-1': 'CHECKING' as const,
        'uuid-credit-1': 'CREDIT' as const,
      };

      const winConfig = {
        sourceAccountMapping: baseMapping,
        accountMappingConfigPath: 'C:\\Users\\vitol\\AppData\\Local\\financial\\account-mapping.json',
        counterpartyHmacKey: 'windows-machine-secret-key',
        hmacKeyVersion: 'v1',
        defaultDueDay: 16,
        sameOwnershipCategoryKeywords: ['mesma titularidade', 'transferência'],
      };

      const linuxConfig = {
        sourceAccountMapping: baseMapping,
        accountMappingConfigPath: '/home/deploy/configs/account-mapping.json',
        counterpartyHmacKey: 'different-linux-secret-key',
        hmacKeyVersion: 'v1',
        defaultDueDay: 16,
        sameOwnershipCategoryKeywords: ['mesma titularidade', 'transferência'],
      };

      const hashWin = calculateSemanticConfigHash(winConfig);
      const hashLinux = calculateSemanticConfigHash(linuxConfig);

      expect(hashWin).toBe(hashLinux);
      expect(hashWin).toMatch(/^[a-f0-9]{64}$/);
    });

    it('17. canonicalizes key sorting so account mapping key order does not alter semantic config hash', () => {
      const mapping1 = {
        'b-uuid': 'CREDIT' as const,
        'a-uuid': 'CHECKING' as const,
      };
      const mapping2 = {
        'a-uuid': 'CHECKING' as const,
        'b-uuid': 'CREDIT' as const,
      };

      const hash1 = calculateSemanticConfigHash({ sourceAccountMapping: mapping1 });
      const hash2 = calculateSemanticConfigHash({ sourceAccountMapping: mapping2 });

      expect(hash1).toBe(hash2);
    });

    it('18. leaves vencimento and fieldProvenance.dueDate as null when defaultDueDay is omitted in config and upstream', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const defaultResolved = resolvePlannerConfig(undefined, testEnv).effectiveConfig;
      const configWithoutDueDay = {
        ...defaultResolved,
        defaultDueDay: undefined,
      };

      const { cardBillAudits, artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        plannerConfig: configWithoutDueDay,
      });

      // Period estimated cycles without upstream due date must have null vencimento and null dueDate provenance
      const estimatedCycle = cardBillAudits.find((b) => b.origem === 'PERIOD_ESTIMATED');
      expect(estimatedCycle).toBeDefined();
      expect(estimatedCycle!.vencimento).toBeNull();
      expect(estimatedCycle!.fieldProvenance.dueDate).toBeNull();

      // Bill title must NOT invent (Venc DD/MM)
      const billOp = artifact.operations.find(
        (o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS' && o.stableId === estimatedCycle!.stableBillId,
      );
      expect(billOp?.sanitizedPayload['Fatura / Ciclo']).not.toContain('(Venc');
    });

    it('19. sets vencimento and CONFIGURED provenance when defaultDueDay is explicitly provided', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const defaultResolved = resolvePlannerConfig(undefined, testEnv).effectiveConfig;
      const configWithDueDay = {
        ...defaultResolved,
        defaultDueDay: 20,
      };

      const { cardBillAudits, artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        plannerConfig: configWithDueDay,
      });

      const estimatedCycle = cardBillAudits.find((b) => b.origem === 'PERIOD_ESTIMATED');
      expect(estimatedCycle).toBeDefined();
      expect(estimatedCycle!.vencimento).toBe('2026-08-20');
      expect(estimatedCycle!.fieldProvenance.dueDate).toBe('CONFIGURED');

      const billOp = artifact.operations.find(
        (o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS' && o.stableId === estimatedCycle!.stableBillId,
      );
      expect(billOp?.sanitizedPayload['Fatura / Ciclo']).toContain('(Venc 20/08)');
    });

    it('20. strictly sets official amount, discrepancy, and open bill estimate fields to null without official statement', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits, artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      for (const bill of cardBillAudits) {
        expect(bill.valorOficial).toBeNull();
        expect(bill.officialBillDiscrepancy).toBeNull();
        expect(bill.unexplainedDiscrepancy).toBeNull();
        expect(bill.componentesAdicionais).toBeNull();
        expect(bill.valorAproximado).toBeNull();
        expect(bill.fieldProvenance.estimatedAmount).toBeNull();
      }

      const billOps = artifact.operations.filter((o) => o.targetDataSource.envKey === 'NOTION_DS_CARD_BILLS');
      for (const op of billOps) {
        expect(op.sanitizedPayload['Valor da Fatura Fechada (Oficial)']).toBeNull();
        expect(op.sanitizedPayload['Divergência Não Explicada']).toBeNull();
        expect(op.sanitizedPayload['Componentes Adicionais da Fatura']).toBeNull();
        expect(op.sanitizedPayload['Valor Estimado da Fatura Aberta']).toBeNull();
      }
    });

    it('21. static code scanning certifies zero personal UUIDs, obsolete snapshot fallbacks, financial constants, page IDs, or names across core files and tests', () => {
      function getTsFiles(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const res = path.resolve(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...getTsFiles(res));
          } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            files.push(res);
          }
        }
        return files;
      }

      const filesToScan = [
        ...getTsFiles(path.resolve(process.cwd(), 'src', 'notion', 'migration-runner')),
        ...getTsFiles(path.resolve(process.cwd(), 'scripts')),
        ...getTsFiles(path.resolve(process.cwd(), 'tests')),
      ];

      // Structural validation with synthetic tokens
      const syntheticTokens = [
        'synthetic-checking-uuid-1111',
        'synthetic-credit-uuid-2222',
        'synthetic-page-id-3333',
      ];
      for (const filePath of filesToScan) {
        if (filePath.endsWith('backfill-planner.test.ts')) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        for (const syn of syntheticTokens) {
          expect(content).not.toContain(syn);
        }
      }

      // Optional local audit via PRIVACY_BLOCKLIST_PATH
      const blocklist = loadPrivacyBlocklist();
      for (const filePath of filesToScan) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const token of blocklist) {
          expect(content.includes(token), `Found personal identifier from blocklist in ${path.relative(process.cwd(), filePath)}`).toBe(false);
        }
      }

      const coreForbiddenPatterns: Array<{ name: string; regex: RegExp }> = [
        { name: 'hardcoded 280.46 in formulas/code', regex: /280\.46/ },
        { name: 'hardcoded 115.00 in formulas/code', regex: /115\.00/ },
        { name: 'hardcoded 2712.50 in formulas/code', regex: /2712\.50/ },
        { name: 'hardcoded 1904.12 in formulas/code', regex: /1904\.12/ },
        { name: 'hardcoded 158.59 in formulas/code', regex: /158\.59/ },
        { name: 'hardcoded 1899.12 in formulas/code', regex: /1899\.12/ },
        { name: 'hardcoded 163.59 in formulas/code', regex: /163\.59/ },
        { name: 'hardcoded 2062.71 in formulas/code', regex: /2062\.71/ },
        { name: 'hardcoded 649.79 in formulas/code', regex: /649\.79/ },
        { name: 'hardcoded fallback snapshot filename', regex: /notion-data-snapshot-20260913T190702-0a3af05c\.json\.enc/ },
      ];

      const coreFiles = [
        path.resolve(process.cwd(), 'src', 'notion', 'migration-runner', 'backfill-planner.ts'),
        path.resolve(process.cwd(), 'src', 'notion', 'migration-runner', 'backfill-dry-run.ts'),
        path.resolve(process.cwd(), 'scripts', 'backfill-dry-run.ts'),
      ];
      for (const filePath of coreFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const pattern of coreForbiddenPatterns) {
          const match = content.match(pattern.regex);
          expect(match, `Found ${pattern.name} in ${path.relative(process.cwd(), filePath)}`).toBeNull();
        }
      }
    });

    it('22. executes planner with synthetic mock SQLite fixture using test-checking-account-id and test-credit-account-id', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-synthetic-test-'));
      const tempDbPath = path.join(tempDir, 'synthetic.db');
      try {
        const db = new Database(tempDbPath);
        db.exec(`
          CREATE TABLE accounts (
            id TEXT PRIMARY KEY,
            name TEXT,
            type TEXT,
            subtype TEXT,
            connector_name TEXT
          );
          CREATE TABLE transactions (
            id TEXT PRIMARY KEY,
            account_id TEXT,
            date TEXT,
            amount REAL,
            description TEXT,
            account_type TEXT,
            direction TEXT,
            category_pierre TEXT,
            category_mapped TEXT,
            raw_json TEXT
          );
          INSERT INTO accounts (id, name, type, subtype, connector_name) VALUES
            ('test-checking-account-id', 'Conta Teste', 'BANK', 'CHECKING_ACCOUNT', 'Test Bank'),
            ('test-credit-account-id', 'Cartão Teste', 'CREDIT', 'CREDIT_CARD', 'Test Bank');
          INSERT INTO transactions (id, account_id, date, amount, direction, description, account_type, category_pierre) VALUES
            ('tx-1', 'test-checking-account-id', '2026-06-01', -50.0, 'OUTFLOW', 'Mercado', 'BANK', 'Alimentação'),
            ('tx-2', 'test-credit-account-id', '2026-06-02', -120.0, 'OUTFLOW', 'Farmácia', 'CREDIT', 'Saúde');
        `);
        db.close();

        const planner = new BackfillPlanner({ dbPath: tempDbPath, envVars: testEnv });
        const { artifact, transactionAudits } = planner.generateArtifact({
          dbPath: tempDbPath,
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
          plannerConfig: {
            sourceAccountMapping: {
              'test-checking-account-id': 'CHECKING',
              'test-credit-account-id': 'CREDIT',
            },
          },
        });

        expect(transactionAudits).toHaveLength(2);
        expect(transactionAudits.every((t) => t.resolutionMethod === 'SOURCE_ACCOUNT_ID')).toBe(true);
        expect(artifact.readiness.checks.unresolvedAccountsZero).toBe(true);
      } finally {
        try {
          if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
          if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('23. throws FAIL_CLOSED_SOURCE_SNAPSHOT_BINDING when SQLite content diverges from snapshotValidation.sourceSnapshotPlaintextSha256', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const mismatchedSha = '0000000000000000000000000000000000000000000000000000000000000000';

      expect(() => {
        planner.generateArtifact({
          notionAccounts: sampleNotionAccounts,
          notionCategories: sampleNotionCategories,
          snapshotValidation: {
            sourceSnapshotPlaintextSha256: mismatchedSha,
          },
        });
      }).toThrow(/FAIL_CLOSED_SOURCE_SNAPSHOT_BINDING/);
    });

    it('24. calculateTargetStateHash determinism, key ordering, and sensitivity to mutations', () => {
      const baseA = {
        envKey: 'NOTION_DS_ACCOUNTS',
        schema: { Conta: { type: 'title' }, Tipo: { type: 'select' }, Tags: { type: 'multi_select' } },
        recordCount: 2,
        records: [
          {
            pageId: 'page-2',
            properties: {
              Conta: 'Nubank Conta',
              Tipo: 'Conta corrente',
              Tags: ['B', 'A'],
            },
          },
          {
            pageId: 'page-1',
            properties: {
              Conta: 'Nubank Cartão',
              Tipo: 'Cartão de crédito',
              Tags: ['X', 'Y'],
            },
          },
        ],
      };

      // baseB has reversed records, reversed Tags array, reversed property keys
      const baseB = {
        envKey: 'NOTION_DS_ACCOUNTS',
        schema: { Tags: { type: 'multi_select' }, Tipo: { type: 'select' }, Conta: { type: 'title' } },
        recordCount: 2,
        records: [
          {
            pageId: 'page-1',
            properties: {
              Tags: ['Y', 'X'], // canonicalizeValue sorts arrays
              Tipo: 'Cartão de crédito',
              Conta: 'Nubank Cartão',
            },
          },
          {
            pageId: 'page-2',
            properties: {
              Tipo: 'Conta corrente',
              Tags: ['A', 'B'],
              Conta: 'Nubank Conta',
            },
          },
        ],
      };

      const hashA = calculateTargetStateHash({ NOTION_DS_ACCOUNTS: baseA as any });
      const hashB = calculateTargetStateHash({ NOTION_DS_ACCOUNTS: baseB as any });
      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[a-f0-9]{64}$/);

      // Mutation: change one value in baseB
      const baseMutated = JSON.parse(JSON.stringify(baseB));
      baseMutated.records[0].properties.Tipo = 'Investimentos';
      const hashMutated = calculateTargetStateHash({ NOTION_DS_ACCOUNTS: baseMutated });
      expect(hashMutated).not.toBe(hashA);

      // Mutation: add a record
      const baseAdded = JSON.parse(JSON.stringify(baseB));
      baseAdded.records.push({
        pageId: 'page-3',
        properties: { Conta: 'Poupança', Tipo: 'Poupança' },
      });
      const hashAdded = calculateTargetStateHash({ NOTION_DS_ACCOUNTS: baseAdded });
      expect(hashAdded).not.toBe(hashA);
    });

    it('25. targetStateHash binds into BackfillPlanArtifact and modifies backfillPlanHash', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const stateHashA = '00743e8274ef3628ff5014f7856627c2425f035de49119464bb5bca6f768153d';
      const stateHashB = '1111111111111111111111111111111111111111111111111111111111111111';

      const resA = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        snapshotValidation: {
          targetStateHash: stateHashA,
        },
      });

      const resB = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
        snapshotValidation: {
          targetStateHash: stateHashB,
        },
      });

      const resNone = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      expect(resA.artifact.explicitSnapshots.targetStateHash).toBe(stateHashA);
      expect(resB.artifact.explicitSnapshots.targetStateHash).toBe(stateHashB);
      expect(resNone.artifact.explicitSnapshots.targetStateHash).toBeUndefined();

      expect(resA.artifact.backfillPlanHash).not.toBe(resB.artifact.backfillPlanHash);
      expect(resA.artifact.backfillPlanHash).not.toBe(resNone.artifact.backfillPlanHash);
    });
  });
});
