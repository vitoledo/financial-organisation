import { describe, it, expect } from 'vitest';
import {
  BackfillPlanner,
  validateOperationAgainstContract,
} from '../src/notion/migration-runner/backfill-planner';

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

  const testEnv = {
    NOTION_API_KEY: 'test-key',
    NOTION_DS_ACCOUNTS: 'fake-acc-ds',
    NOTION_DS_CATEGORIES: 'fake-cat-ds',
    NOTION_DS_TRANSACTIONS: 'fake-tx-ds',
    NOTION_DS_CARD_BILLS: 'fake-bills-ds',
    NOTION_DS_MONTHLY_BUDGET: 'fake-budget-ds',
    NOTION_TARGET_SNAPSHOT_MANIFEST: 'backups/notion-data-snapshot-20260913T190702-0a3af05c.json.enc.manifest.json',
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
    it('produces exactly 160 CREATE operations and 0 UPDATE operations', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact, proposedDerivedUpdates } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      expect(artifact.summary.executableCreateCount).toBe(160);
      expect(artifact.summary.executableUpdateCount).toBe(0);
      expect(artifact.summary.proposedReviewCount).toBe(0);
      expect(artifact.operations).toHaveLength(160);
      expect(artifact.operations.every((op) => op.operationType === 'CREATE')).toBe(true);

      // Verify the 2 derived updates are recorded as OUT_OF_SCOPE_NOT_EXECUTED outside operations
      expect(proposedDerivedUpdates).toHaveLength(2);
      expect(proposedDerivedUpdates.every((u) => u.status === 'OUT_OF_SCOPE_NOT_EXECUTED')).toBe(true);
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
      expect(billOps).toHaveLength(5);

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

    it('includes all 14 dynamic readiness checks in BackfillPlanArtifact', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      const checks = artifact.readiness.checks;
      expect(Object.keys(checks)).toHaveLength(14);
      expect(checks).toHaveProperty('schemaConformant13Of13');
      expect(checks).toHaveProperty('missingPropertiesZero');
      expect(checks).toHaveProperty('structuralMismatchesZero');
      expect(checks).toHaveProperty('duplicatesZero');
      expect(checks).toHaveProperty('unresolvedAccountsZero');
      expect(checks).toHaveProperty('unresolvedCategoriesZero');
      expect(checks).toHaveProperty('unresolvedPaymentAllocationsZero');
      expect(checks).toHaveProperty('financialDiscrepancyZero');
      expect(checks).toHaveProperty('identityCollisionsZero');
      expect(checks).toHaveProperty('targetSnapshotValid');
      expect(checks).toHaveProperty('sourceBackupValid');
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
        _mockExpectedEconomicExpenses: 2712.51,
      });
      expect(artifact.readiness.checks.financialDiscrepancyZero).toBe(false);
      expect(artifact.readiness.blockers).toContain(
        'FINANCIAL_DISCREPANCY: Discrepância financeira residual detectada (R$ 0.01).',
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

    it('excludes outgoing internal transfers (R$ 115,00) from economic expenses', () => {
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
      expect(Math.round(totalExpenses * 100) / 100).toBe(2712.5);
    });

    it('treats 36 third-party inflows as economically pending review with null nature and effect', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact, incomingTransferAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      expect(artifact.readiness.pendingEconomicClassificationCount).toBe(36);

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

    it('audits card cycles status and unexplained discrepancy accurately', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { cardBillAudits } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      expect(cardBillAudits).toHaveLength(5);

      // Cycle 2 (June) - fully paid with external payment included
      const cycle2 = cardBillAudits.find((b) => b.stableBillId === 'nubank:bill:a5ea6710-2f6e-4663-a237-2c062b8fa8d7');
      expect(cycle2).toBeDefined();
      expect(cycle2!.somaCompras).toBe(171.79);
      expect(cycle2!.paidAmount).toBe(171.79);
      expect(cycle2!.unexplainedDiscrepancy).toBe(0);
      expect(cycle2!.status).toBe('Paga Integralmente');
      expect(cycle2!.dataLiquidacao).toBe('2026-06-12');

      // Cycle 3 (July) - fully paid
      const cycle3 = cardBillAudits.find((b) => b.stableBillId === 'nubank:bill:f4513058-c028-4b90-b663-16f27d0e2d8e');
      expect(cycle3).toBeDefined();
      expect(cycle3!.somaCompras).toBe(55.89);
      expect(cycle3!.paidAmount).toBe(55.89);
      expect(cycle3!.unexplainedDiscrepancy).toBe(0);
      expect(cycle3!.status).toBe('Paga Integralmente');
      expect(cycle3!.dataLiquidacao).toBe('2026-07-06');

      // Cycle 1 (May) - partially paid, discrepancy 24.85
      const cycle1 = cardBillAudits.find((b) => b.stableBillId === 'nubank:bill:7f6be926-ae1b-4685-a830-8ec6e773fbf0');
      expect(cycle1).toBeDefined();
      expect(cycle1!.somaCompras).toBe(7.08);
      expect(cycle1!.paidAmount).toBe(31.93);
      expect(cycle1!.unexplainedDiscrepancy).toBe(24.85);
      expect(cycle1!.status).toBe('Paga Parcialmente');

      // Cycle 4 (July open/fallback) - partially paid, discrepancy 316.24
      const cycle4 = cardBillAudits.find((b) => b.stableBillId === 'nubank:cartao:2026-07:cycle');
      expect(cycle4).toBeDefined();
      expect(cycle4!.somaCompras).toBe(415.03);
      expect(cycle4!.paidAmount).toBe(98.79);
      expect(cycle4!.unexplainedDiscrepancy).toBe(316.24);
      expect(cycle4!.status).toBe('Paga Parcialmente');
    });
  });
});
