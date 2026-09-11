import { describe, test, expect } from 'vitest';
import crypto from 'crypto';
import {
  Money,
  DecimalQuantity,
  buildTransactionIdempotencyKey,
  calculateCanonicalFingerprint,
  calculateSensitiveHmac,
  EncryptionService,
} from '../src/domain/types';
import { TARGET_CONTRACT } from '../src/domain/schema-contract';
import { NotionSchemaValidator } from '../src/notion/schema-validator';

describe('Domain: Money (BigInt Minor Units)', () => {
  test('creates Money from cents correctly', () => {
    const m = Money.fromCents(1500n);
    expect(m.amountMinor).toBe(1500n);
    expect(m.currency).toBe('BRL');
    expect(m.toDecimal()).toBe(15.0);
    expect(m.toDecimalString()).toBe('15.00');
    expect(m.toFormattedBR()).toBe('R$ 15,00');
  });

  test('creates Money from decimal string and number', () => {
    const m1 = Money.fromDecimal('1250.50');
    expect(m1.amountMinor).toBe(125050n);
    expect(m1.toFormattedBR()).toBe('R$ 1.250,50');

    const m2 = Money.fromDecimal(400.25);
    expect(m2.amountMinor).toBe(40025n);

    const m3 = Money.fromDecimal('-15.00');
    expect(m3.amountMinor).toBe(-1500n);
    expect(m3.isNegative()).toBe(true);
    expect(m3.toFormattedBR()).toBe('-R$ 15,00');
  });

  test('arithmetic operations preserve exact precision', () => {
    const a = Money.fromDecimal('0.10');
    const b = Money.fromDecimal('0.20');
    const sum = a.add(b);
    expect(sum.amountMinor).toBe(30n);
    expect(sum.toDecimalString()).toBe('0.30'); // No 0.30000000000000004!

    const diff = a.subtract(b);
    expect(diff.amountMinor).toBe(-10n);
    expect(diff.abs().amountMinor).toBe(10n);
  });

  test('prevents currency mismatch', () => {
    const brl = Money.fromCents(1000n, 'BRL');
    const usd = Money.fromCents(1000n, 'USD');
    expect(() => brl.add(usd)).toThrow('Currency/scale mismatch');
  });

  test('supports generic currencies and custom scales (e.g. JPY scale 0, USD scale 2)', () => {
    const jpy = Money.fromMinor(1500n, 'JPY', 0);
    expect(jpy.amountMinor).toBe(1500n);
    expect(jpy.currency).toBe('JPY');
    expect(jpy.scale).toBe(0);
    expect(jpy.toDecimalString()).toBe('1500');

    const usd = Money.fromDecimal('49.99', 'USD', 2);
    expect(usd.currency).toBe('USD');
    expect(usd.amountMinor).toBe(4999n);
    const doubled = usd.multiply(2);
    expect(doubled.amountMinor).toBe(9998n);
    expect(doubled.toDecimalString()).toBe('99.98');
  });
});

describe('Domain: DecimalQuantity (Asset Fractions e.g. BTC)', () => {
  test('preserves high decimal precision up to 8 places', () => {
    const btc = DecimalQuantity.fromDecimal('0.00034500', 8);
    expect(btc.scale).toBe(8);
    expect(btc.toNumber()).toBe(0.000345);
    expect(btc.toCanonicalString()).toBe('0.000345');
  });

  test('handles integer and zero quantities', () => {
    const zero = DecimalQuantity.zero();
    expect(zero.isZero()).toBe(true);
    expect(zero.toCanonicalString()).toBe('0');
  });
});

describe('Domain: Transaction Idempotency Key & Canonical Fingerprint', () => {
  test('composite key enforces UNIQUE(source, sourceAccountId, sourceTransactionId)', () => {
    const key = buildTransactionIdempotencyKey({
      source: 'PIERRE',
      sourceAccountId: 'acc-nubank-1',
      sourceTransactionId: 'tx-12345',
    });
    expect(key).toBe('PIERRE:acc-nubank-1:tx-12345');
  });

  test('canonical fingerprint produces exact 64-char SHA-256 and detects state changes', () => {
    const basePayload = {
      source: 'PIERRE',
      sourceAccountId: 'acc-1',
      sourceTransactionId: 'tx-99',
      amountMinor: 1500n,
      currency: 'BRL',
      dateIso: '2026-06-29T17:51:21.000Z',
      status: 'PENDING',
      description: 'Pagamento de fatura',
      rawCategory: 'Pagamento de cartão',
      direction: 'OUTFLOW',
    };

    const hashPending = calculateCanonicalFingerprint(basePayload);
    expect(hashPending).toHaveLength(64);

    // Change status from PENDING to POSTED
    const hashPosted = calculateCanonicalFingerprint({
      ...basePayload,
      status: 'POSTED',
    });

    expect(hashPosted).toHaveLength(64);
    expect(hashPending).not.toBe(hashPosted); // Fingerprint strictly changes on status transition!

    // Change amount
    const hashAmountChanged = calculateCanonicalFingerprint({
      ...basePayload,
      amountMinor: 1600n,
    });
    expect(hashAmountChanged).not.toBe(hashPending);
  });

  test('sensitive HMAC obscures CPF/CNPJ while allowing deterministic matching with AUDIT_HMAC_SECRET_KEY', () => {
    const hmacSecretKey = 'a3f89e210b42c6789123456789abcdef0123456789abcdef0123456789abcdef';
    const cpf = '542.672.928-09';
    const hmac1 = calculateSensitiveHmac(cpf, hmacSecretKey);
    const hmac2 = calculateSensitiveHmac('54267292809', hmacSecretKey); // Different punctuation, same digits

    expect(hmac1).toHaveLength(64);
    expect(hmac1).toBe(hmac2); // Canonical digits match
    expect(hmac1).not.toContain('542'); // Does not leak raw PII
  });
});

describe('Domain: AES-256-GCM Encryption Service', () => {
  test('encrypts and decrypts with random 256-bit key, 12-byte IV, and auth tag', () => {
    const key = EncryptionService.generateRandomKey();
    expect(key).toHaveLength(32); // Exactly 256 bits

    const service = new EncryptionService(key, 1);
    const secretData = JSON.stringify({ sensitiveAccount: '29902181-9', balance: 9.22 });

    const envelope = service.encrypt(secretData);
    expect(envelope.keyVersion).toBe(1);
    expect(envelope.iv).toBeTruthy();
    expect(envelope.authTag).toBeTruthy();
    expect(envelope.ciphertext).toBeTruthy();

    const decrypted = service.decryptToString(envelope);
    expect(decrypted).toBe(secretData);
  });

  test('detects tampering with auth tag or ciphertext', () => {
    const key = EncryptionService.generateRandomKey();
    const service = new EncryptionService(key, 1);
    const envelope = service.encrypt('tamper-test');

    // Corrupt ciphertext
    const tamperedCiphertext = Buffer.from(envelope.ciphertext, 'base64');
    tamperedCiphertext[0] ^= 0xff; // Flip bit
    const tamperedEnvelope = { ...envelope, ciphertext: tamperedCiphertext.toString('base64') };

    expect(() => service.decrypt(tamperedEnvelope)).toThrow();
  });
});

describe('Domain: Schema Contract Specification', () => {
  test('defines exactly 13 data sources with 12 existing and 1 proposed', () => {
    const keys = Object.keys(TARGET_CONTRACT);
    expect(keys).toHaveLength(13);

    const existing = keys.filter((k) => TARGET_CONTRACT[k].isExisting);
    const proposed = keys.filter((k) => !TARGET_CONTRACT[k].isExisting);

    expect(existing).toHaveLength(12);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toBe('NOTION_DS_CARD_BILLS');
  });

  test('all properties declare valid types, authority and directions', () => {
    const validTypes = new Set([
      'title', 'rich_text', 'number', 'select', 'multi_select',
      'date', 'relation', 'checkbox', 'formula', 'rollup',
      'created_time', 'last_edited_time',
    ]);
    const validAuthorities = new Set(['PIERRE', 'REGRA_AUTOMATICA', 'USUARIO', 'DERIVADO']);

    for (const [dsKey, ds] of Object.entries(TARGET_CONTRACT)) {
      expect(ds.properties.length).toBeGreaterThan(0);
      for (const p of ds.properties) {
        expect(validTypes.has(p.notionType)).toBe(true);
        expect(validAuthorities.has(p.authority)).toBe(true);
        expect(['read', 'write', 'both']).toContain(p.direction);
      }
    }
  });

  test('excludes Caixa Reservado from Investimentos asset positions', () => {
    const investmentsContract = TARGET_CONTRACT.NOTION_DS_INVESTMENTS;
    const assetTypeProp = investmentsContract.properties.find((p) => p.domainField === 'assetType');
    expect(assetTypeProp).toBeDefined();
    expect(assetTypeProp?.description).toContain('Caixa Reservado NÃO é classe de ativo');
  });

  test('preserves useful historical fields in Fechamentos Mensais, Log de Sincronização and Contas Fixas', () => {
    const closings = TARGET_CONTRACT.NOTION_DS_MONTHLY_CLOSINGS.properties.map((p) => p.domainField);
    expect(closings).toContain('initialNetWorth');
    expect(closings).toContain('essentialExpenses');
    expect(closings).toContain('discretionaryExpenses');
    expect(closings).toContain('investmentYield');
    expect(closings).toContain('netWorthChange');

    const syncLog = TARGET_CONTRACT.NOTION_DS_SYNC_LOG.properties.map((p) => p.domainField);
    expect(syncLog).toContain('startedAt');
    expect(syncLog).toContain('endedAt');
    expect(syncLog).toContain('installmentsReceived');
    expect(syncLog).toContain('sourceFreshness');
    expect(syncLog).toContain('workerCommit');

    const fixedBills = TARGET_CONTRACT.NOTION_DS_FIXED_BILLS.properties.map((p) => p.domainField);
    expect(fixedBills).toContain('anchorCompetence');
    expect(fixedBills).toContain('lastGeneratedCompetence');
    expect(fixedBills).toContain('periodicity');
    expect(fixedBills).toContain('paymentMethod');
    expect(fixedBills).toContain('notes');
  });

  test('CardBill specifies plural payment transactions and additional components without false divergence', () => {
    const cardBillsProps = TARGET_CONTRACT.NOTION_DS_CARD_BILLS.properties;
    const paymentProp = cardBillsProps.find((p) => p.domainField === 'paymentTransactions');
    expect(paymentProp).toBeDefined();
    expect(paymentProp?.notionProperty).toBe('Transações de Pagamento');
    expect(paymentProp?.notionType).toBe('relation');

    const additionalCompProp = cardBillsProps.find((p) => p.domainField === 'additionalComponentsAmount');
    expect(additionalCompProp).toBeDefined();
    expect(additionalCompProp?.notionProperty).toBe('Componentes Adicionais da Fatura');

    const unexplainedProp = cardBillsProps.find((p) => p.domainField === 'unexplainedDiscrepancy');
    expect(unexplainedProp).toBeDefined();
    expect(unexplainedProp?.notionProperty).toBe('Divergência Não Explicada');
  });
});

describe('Notion: Schema Validator (Phase 0 Introspector)', () => {
  test('handles missing environment IDs gracefully without throwing', async () => {
    const validator = new NotionSchemaValidator(); // Offline mode
    const report = await validator.runIntrospection({});

    expect(report.totalDataSources).toBe(13);
    expect(report.existingInspected).toBe(12);
    expect(report.configuredCount).toBe(0);

    // NOTION_DS_CARD_BILLS is marked as PROPOSED_NEW_DATABASE
    expect(report.results.NOTION_DS_CARD_BILLS.status).toBe('PROPOSED_NEW_DATABASE');

    // Existing ones are marked as MISSING_ENV_ID
    expect(report.results.NOTION_DS_ACCOUNTS.status).toBe('MISSING_ENV_ID');
    expect(report.results.NOTION_DS_TRANSACTIONS.status).toBe('MISSING_ENV_ID');
  });

  test('generates clean markdown manifest without leaking tokens', async () => {
    const validator = new NotionSchemaValidator();
    const report = await validator.runIntrospection({});
    const md = validator.generateMarkdownManifest(report);

    expect(md).toContain('# Manifesto de Schema-Delta: Notion vs. Modelo de Domínio (Fase 0)');
    expect(md).toContain('NOTION_DS_CARD_BILLS');
    expect(md).toContain('NOTION_DS_ACCOUNTS');
    expect(md).toContain('MISSING_ENV_ID');
    expect(md).not.toContain('secret_');
    expect(md).not.toContain('Bearer');
  });
});
