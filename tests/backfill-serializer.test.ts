import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import {
  serializePayloadForNotion,
  canonicalizePageRecord,
  calculatePropertiesFingerprint,
  calculateRecordFingerprint,
  resolveStableIdentitySpec,
  findPropertyContract,
} from '../src/notion/migration-runner/backfill-serializer';
import { TARGET_CONTRACT } from '../src/domain/schema-contract';
import { BackfillDryRunAnalyzer } from '../src/notion/migration-runner/backfill-dry-run';
import { BackfillOperation } from '../src/notion/migration-runner/types';

describe('Phase 2D: Runtime Physical Property Binding & Serializer Hardening', () => {
  const sampleTxPayload = {
    'Lançamento': 'Almoço Restaurante Teste',
    'Fonte': 'Pierre',
    'ID da fonte': 'tx-uuid-12345',
    'Moeda': 'BRL',
    'Hash Canônico': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'Data': { start: '2026-07-15', end: null },
    'Valor': 50.0,
    'Valor Bruto da Fonte': -50.0,
    'Movimento': 'Saída',
    'Natureza': 'Despesa',
    'Efeito Orçamentário': 'Despesa',
    'Propósito de Alocação': 'Caixa Operacional',
    'Contribuição Meta Poupança': 0,
    'Status': 'Confirmado',
    'Status de Revisão': 'Confirmado Auto',
    'Motivo da Revisão': '',
    'Categoria Pierre': 'Alimentação',
    'Descrição original': 'RESTAURANTE TESTE 123',
    'HMAC Contraparte': 'hmac-counterparty-xyz',
  };

  it('preserves physical property name "ID da fonte" in Notion payload', () => {
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true);
    expect(serialized.notionProperties['ID da fonte']).toBeDefined();
    expect(serialized.notionProperties['ID da fonte'].rich_text[0].text.content).toBe('tx-uuid-12345');
    expect(serialized.notionProperties['ID da Fonte']).toBeUndefined();
  });

  it('preserves physical property name "Lançamento" in Notion payload (does not rename to Descrição)', () => {
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true);
    expect(serialized.notionProperties['Lançamento']).toBeDefined();
    expect(serialized.notionProperties['Lançamento'].title[0].text.content).toBe('Almoço Restaurante Teste');
    expect(serialized.notionProperties['Descrição']).toBeUndefined();
  });

  it('preserves physical property name "Natureza" in Notion payload (does not rename to Natureza Econômica)', () => {
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true);
    expect(serialized.notionProperties['Natureza']).toBeDefined();
    expect(serialized.notionProperties['Natureza'].select.name).toBe('Despesa');
    expect(serialized.notionProperties['Natureza Econômica']).toBeUndefined();
  });

  it('preserves physical property name "Status" in Notion payload (does not rename to Status Banco)', () => {
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true);
    expect(serialized.notionProperties['Status']).toBeDefined();
    expect(serialized.notionProperties['Status'].select.name).toBe('Confirmado');
    expect(serialized.notionProperties['Status Banco']).toBeUndefined();
  });

  it('preserves physical property name "Descrição original" in Notion payload (does not rename to Descrição Original)', () => {
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true);
    expect(serialized.notionProperties['Descrição original']).toBeDefined();
    expect(serialized.notionProperties['Descrição original'].rich_text[0].text.content).toBe('RESTAURANTE TESTE 123');
    expect(serialized.notionProperties['Descrição Original']).toBeUndefined();
  });

  it('canonicalProperties strictly continues using semantic contract property names for deterministic fingerprinting', () => {
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true);
    expect(serialized.canonicalProperties['Descrição']).toBe('Almoço Restaurante Teste');
    expect(serialized.canonicalProperties['ID da Fonte']).toBe('tx-uuid-12345');
    expect(serialized.canonicalProperties['Natureza Econômica']).toBe('Despesa');
    expect(serialized.canonicalProperties['Status Banco']).toBe('Confirmado');
    expect(serialized.canonicalProperties['Descrição Original']).toBe('RESTAURANTE TESTE 123');
    expect(serialized.canonicalProperties['Lançamento']).toBeUndefined();
    expect(serialized.canonicalProperties['ID da fonte']).toBeUndefined();
    expect(serialized.canonicalProperties['Natureza']).toBeUndefined();
    expect(serialized.canonicalProperties['Status']).toBeUndefined();
  });

  it('read-back with live physical aliases yields fingerprint identical to expected canonical fingerprint', () => {
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true);
    const expectedFingerprint = calculatePropertiesFingerprint('NOTION_DS_TRANSACTIONS', serialized.canonicalProperties);

    // Simulate raw Notion page record returning physical properties
    const rawLivePageRecord = {
      'Lançamento': { type: 'title', title: [{ text: { content: 'Almoço Restaurante Teste' }, plain_text: 'Almoço Restaurante Teste' }] },
      'Fonte': { type: 'select', select: { name: 'Pierre' } },
      'ID da fonte': { type: 'rich_text', rich_text: [{ text: { content: 'tx-uuid-12345' }, plain_text: 'tx-uuid-12345' }] },
      'Moeda': { type: 'select', select: { name: 'BRL' } },
      'Hash Canônico': { type: 'rich_text', rich_text: [{ text: { content: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }, plain_text: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }] },
      'Data': { type: 'date', date: { start: '2026-07-15', end: null } },
      'Valor': { type: 'number', number: 50.0 },
      'Valor Bruto da Fonte': { type: 'number', number: -50.0 },
      'Movimento': { type: 'select', select: { name: 'Saída' } },
      'Natureza': { type: 'select', select: { name: 'Despesa' } },
      'Efeito Orçamentário': { type: 'select', select: { name: 'Despesa' } },
      'Propósito de Alocação': { type: 'select', select: { name: 'Caixa Operacional' } },
      'Contribuição Meta Poupança': { type: 'number', number: 0 },
      'Status': { type: 'select', select: { name: 'Confirmado' } },
      'Status de Revisão': { type: 'select', select: { name: 'Confirmado Auto' } },
      'Motivo da Revisão': { type: 'rich_text', rich_text: [] },
      'Categoria Pierre': { type: 'rich_text', rich_text: [{ text: { content: 'Alimentação' }, plain_text: 'Alimentação' }] },
      'Descrição original': { type: 'rich_text', rich_text: [{ text: { content: 'RESTAURANTE TESTE 123' }, plain_text: 'RESTAURANTE TESTE 123' }] },
      'HMAC Contraparte': { type: 'rich_text', rich_text: [{ text: { content: 'hmac-counterparty-xyz' }, plain_text: 'hmac-counterparty-xyz' }] },
    };

    const readBackFingerprint = calculateRecordFingerprint('NOTION_DS_TRANSACTIONS', rawLivePageRecord);
    expect(readBackFingerprint).toBe(expectedFingerprint);
  });

  it('fails fast with FAIL_AMBIGUOUS_RUNTIME_PROPERTY when canonical and alias are both present on the same page', () => {
    const conflictingPageRecord = {
      'Lançamento': { type: 'title', title: [{ text: { content: 'Nome Alias' }, plain_text: 'Nome Alias' }] },
      'Descrição': { type: 'title', title: [{ text: { content: 'Nome Canônico' }, plain_text: 'Nome Canônico' }] },
    };

    expect(() => canonicalizePageRecord('NOTION_DS_TRANSACTIONS', conflictingPageRecord)).toThrow(
      /FAIL_AMBIGUOUS_RUNTIME_PROPERTY.*Descrição.*NOTION_DS_TRANSACTIONS/,
    );
  });

  it('fails fast with FAIL_UNKNOWN_PROPERTY when property is neither canonical nor an explicit alias', () => {
    const invalidPayload = {
      ...sampleTxPayload,
      'campoInvalidoHeuristico': 'valor',
    };
    expect(() => serializePayloadForNotion('NOTION_DS_TRANSACTIONS', invalidPayload, {}, true)).toThrow(
      /FAIL_UNKNOWN_PROPERTY/,
    );
  });

  it('resolves stable identity specification for transactions to "ID da fonte"', () => {
    const spec = resolveStableIdentitySpec({
      targetDataSource: { envKey: 'NOTION_DS_TRANSACTIONS' },
      sanitizedPayload: sampleTxPayload,
      stableId: 'tx-uuid-12345',
    });
    expect(spec.domainField).toBe('sourceTransactionId');
    expect(spec.physicalProperty).toBe('ID da fonte');
    expect(spec.canonicalProperty).toBe('ID da Fonte');
    expect(spec.stableIdValue).toBe('tx-uuid-12345');
  });

  it('resolves stable identity specification for card bills to "ID Estável da Fatura"', () => {
    const billPayload = {
      'Fatura / Ciclo': 'Nubank - Ciclo 2026-07',
      'Fonte': 'Pierre',
      'ID da Fatura na Fonte': 'bill-123',
      'ID Estável da Fatura': 'nubank:cartao:2026-07',
    };
    const spec = resolveStableIdentitySpec({
      targetDataSource: { envKey: 'NOTION_DS_CARD_BILLS' },
      sanitizedPayload: billPayload,
      stableId: 'nubank:cartao:2026-07',
    });
    expect(spec.domainField).toBe('stableBillId');
    expect(spec.physicalProperty).toBe('ID Estável da Fatura');
    expect(spec.canonicalProperty).toBe('ID Estável da Fatura');
    expect(spec.stableIdValue).toBe('nubank:cartao:2026-07');
  });

  it('preserves physical relation property names and validates aliases in relations', () => {
    const relations = {
      'Conta': ['account-page-id-1'],
      'Categoria': ['category-page-id-2'],
    };
    const serialized = serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, relations, true);
    expect(serialized.notionProperties['Conta']).toEqual({ relation: [{ id: 'account-page-id-1' }] });
    expect(serialized.notionProperties['Categoria']).toEqual({ relation: [{ id: 'category-page-id-2' }] });
    expect(serialized.canonicalProperties['Conta']).toEqual(['account-page-id-1']);
    expect(serialized.canonicalProperties['Categoria']).toEqual(['category-page-id-2']);
  });

  it('validates title presence semantically (passes with physical "Lançamento", does not require "Descrição")', () => {
    expect(() =>
      serializePayloadForNotion('NOTION_DS_TRANSACTIONS', sampleTxPayload, {}, true),
    ).not.toThrow();

    const withoutTitle = { ...sampleTxPayload };
    delete (withoutTitle as any)['Lançamento'];
    expect(() => serializePayloadForNotion('NOTION_DS_TRANSACTIONS', withoutTitle, {}, true)).toThrow(
      /FAIL_MISSING_TITLE/,
    );
  });

  it('audits all 159 operations in frozen plan to verify all serialized properties map strictly to valid contracts', { timeout: 30000 }, async () => {
    const testEnv = {
      ...process.env,
      NOTION_API_KEY: process.env.NOTION_API_KEY || 'fake-key',
      NOTION_DS_ACCOUNTS: process.env.NOTION_DS_ACCOUNTS || 'fake-acc-ds',
      NOTION_DS_CATEGORIES: process.env.NOTION_DS_CATEGORIES || 'fake-cat-ds',
      NOTION_DS_TRANSACTIONS: process.env.NOTION_DS_TRANSACTIONS || 'fake-tx-ds',
      NOTION_DS_CARD_BILLS: process.env.NOTION_DS_CARD_BILLS || 'fake-bills-ds',
      NOTION_TARGET_SNAPSHOT_MANIFEST: 'backups/notion-data-snapshot-20260913T190702-0a3af05c.json.enc.manifest.json',
      SOURCE_SQLITE_SNAPSHOT_MANIFEST: 'backups/financial-backup-20260914T023409-a6df794b.db.enc.manifest.json',
      BACKFILL_ACCOUNT_MAPPING_PATH: 'data/account-mapping.json',
      MIGRATION_BACKUP_KEY: process.env.MIGRATION_BACKUP_KEY,
    };
    const analyzer = new BackfillDryRunAnalyzer({
      envVars: testEnv,
      commitSha: '92187f7f712178aac634d23e53e22aa9dededb7c',
    });
    const res = await analyzer.runAnalysis();
    const ops = res.planArtifact.operations as BackfillOperation[];
    expect(ops.length).toBe(159);

    for (const op of ops) {
      const existingRelations: Record<string, string[]> = {};
      for (const [propName, refList] of Object.entries(op.relations)) {
        const existingIds = (refList as any[])
          .filter((r) => r.type === 'EXISTING_PAGE_ID')
          .map((r) => r.target);
        if (existingIds.length > 0) {
          existingRelations[propName] = existingIds;
        }
      }

      const serialized = serializePayloadForNotion(
        op.targetDataSource.envKey,
        op.sanitizedPayload,
        existingRelations,
        true,
      );

      // Verify every physical property in notionProperties is valid in target contract
      for (const propKey of Object.keys(serialized.notionProperties)) {
        const contract = findPropertyContract(op.targetDataSource.envKey, propKey);
        expect(contract).toBeDefined();
        const isCanonical = propKey === contract!.notionProperty;
        const isAlias = Boolean(contract!.aliases && contract!.aliases.includes(propKey));
        expect(isCanonical || isAlias).toBe(true);
      }

      // Verify stable identity resolver produces expected physical key
      const idSpec = resolveStableIdentitySpec(op);
      if (op.targetDataSource.envKey === 'NOTION_DS_TRANSACTIONS') {
        expect(idSpec.physicalProperty).toBe('ID da fonte');
      } else {
        expect(idSpec.physicalProperty).toBe('ID Estável da Fatura');
      }
    }
  });
});
