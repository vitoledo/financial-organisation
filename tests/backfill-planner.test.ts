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

    it('assigns Transações de Pagamento on card bills to the 14 bank cash leg payments', () => {
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
      expect(totalPaymentLegRelations).toBe(14);

      const totalCycleTransactions = billOps.reduce(
        (acc, b) => acc + (b.relations['Lançamentos do Ciclo']?.length || 0),
        0,
      );
      expect(totalCycleTransactions).toBe(20);
    });

    it('includes all 13 dynamic readiness checks in BackfillPlanArtifact', () => {
      const planner = new BackfillPlanner({ envVars: testEnv });
      const { artifact } = planner.generateArtifact({
        notionAccounts: sampleNotionAccounts,
        notionCategories: sampleNotionCategories,
      });

      const checks = artifact.readiness.checks;
      expect(Object.keys(checks)).toHaveLength(13);
      expect(checks).toHaveProperty('schemaConformant13Of13');
      expect(checks).toHaveProperty('missingPropertiesZero');
      expect(checks).toHaveProperty('structuralMismatchesZero');
      expect(checks).toHaveProperty('duplicatesZero');
      expect(checks).toHaveProperty('unresolvedAccountsZero');
      expect(checks).toHaveProperty('unresolvedCategoriesZero');
      expect(checks).toHaveProperty('financialDiscrepancyZero');
      expect(checks).toHaveProperty('identityCollisionsZero');
      expect(checks).toHaveProperty('targetSnapshotValid');
      expect(checks).toHaveProperty('sourceBackupValid');
      expect(checks).toHaveProperty('worktreeClean');
      expect(checks).toHaveProperty('headInSyncWithRemote');
      expect(checks).toHaveProperty('planHashReproducible');
    });
  });
});
