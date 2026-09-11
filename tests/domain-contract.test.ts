import { describe, test, expect } from 'vitest';
import crypto from 'crypto';
import {
  Money,
  DecimalQuantity,
  buildTransactionIdempotencyKey,
  calculateCanonicalFingerprint,
  calculateSensitiveHmac,
  EncryptionService,
  updateCostBasisOnPurchase,
  updateCostBasisOnSale,
  calculateUnrealizedProfitLoss,
  calculateMarketValue,
  calculateBillDiscrepancy,
  TransactionBankStatus,
} from '../src/domain/types';
import { TARGET_CONTRACT } from '../src/domain/schema-contract';
import { NotionSchemaValidator } from '../src/notion/schema-validator';

describe('Domain: Money (BigInt Minor Units & Exact Rational Math)', () => {
  test('creates Money from cents correctly', () => {
    const m = Money.fromCents(1500n);
    expect(m.amountMinor).toBe(1500n);
    expect(m.currency).toBe('BRL');
    expect(m.toDecimal()).toBe(15.0);
    expect(m.toDecimalString()).toBe('15.00');
    expect(m.toFormattedBR()).toBe('R$ 15,00');
  });

  test('creates Money from decimal string and boundary floats', () => {
    const m1 = Money.fromDecimal('1250.50');
    expect(m1.amountMinor).toBe(125050n);
    expect(m1.toFormattedBR()).toBe('R$ 1.250,50');

    // Canonical fromDecimal strictly rejects number:
    expect(() => Money.fromDecimal(400.25 as any)).toThrow(TypeError);

    // Boundary conversion handles number safely:
    const m2 = Money.fromDecimalBoundary(400.25);
    expect(m2.amountMinor).toBe(40025n);

    const m3 = Money.fromDecimal('-15.00');
    expect(m3.amountMinor).toBe(-1500n);
    expect(m3.isNegative()).toBe(true);
    expect(m3.toFormattedBR()).toBe('-R$ 15,00');
  });

  test('exact half-up rounding on 1.005 in BigInt without IEEE-754 loss', () => {
    // 1.005 in scale 2 rounds up to 1.01 (101 minor units)
    const mRoundUp = Money.fromDecimal('1.005');
    expect(mRoundUp.amountMinor).toBe(101n);
    expect(mRoundUp.toDecimalString()).toBe('1.01');
    expect(mRoundUp.toFormattedBR()).toBe('R$ 1,01');

    // 1.004 in scale 2 rounds down to 1.00 (100 minor units)
    const mRoundDown = Money.fromDecimal('1.004');
    expect(mRoundDown.amountMinor).toBe(100n);
    expect(mRoundDown.toDecimalString()).toBe('1.00');

    // 1.0050 with trailing zero rounds to 101n
    const mTrailing = Money.fromDecimal('1.0050');
    expect(mTrailing.amountMinor).toBe(101n);

    // Negative -1.005 rounds to -101n
    const mNeg = Money.fromDecimal('-1.005');
    expect(mNeg.amountMinor).toBe(-101n);
    expect(mNeg.toDecimalString()).toBe('-1.01');

    // DecimalQuantity 1.000000005 with scale 8 rounds up
    const qRoundUp = DecimalQuantity.fromDecimal('1.000000005', 8);
    expect(qRoundUp.rawUnits).toBe(100000001n);

    const qRoundDown = DecimalQuantity.fromDecimal('1.000000004', 8);
    expect(qRoundDown.rawUnits).toBe(100000000n);
  });

  test('rejects unsafe integers in fromMinor and fromCents', () => {
    const unsafeInt = Number.MAX_SAFE_INTEGER + 10;
    expect(() => Money.fromMinor(unsafeInt)).toThrow('requires a safe integer');
    expect(() => Money.fromCents(unsafeInt)).toThrow('requires a safe integer');
    expect(() => Money.fromMinor(NaN)).toThrow('requires a safe integer');
    expect(() => Money.fromMinor(Infinity)).toThrow('requires a safe integer');

    // Safe integers work
    expect(Money.fromMinor(100).amountMinor).toBe(100n);
    expect(Money.fromMinor(Number.MAX_SAFE_INTEGER).amountMinor).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  test('arithmetic operations preserve exact precision without IEEE-754 drift', () => {
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
    const doubled = usd.multiply(2n);
    expect(doubled.amountMinor).toBe(9998n);
    expect(doubled.toDecimalString()).toBe('99.98');
  });

  test('supports exact rational multiplication without float drift', () => {
    const m = Money.fromDecimal('100.00');
    const rationalHalf = m.multiplyRational(1n, 2n);
    expect(rationalHalf.toDecimalString()).toBe('50.00');

    // Rational one-third: 100 * 1 / 3 = 33.33 (3333 minor units)
    const oneThird = m.multiplyRational(1n, 3n);
    expect(oneThird.amountMinor).toBe(3333n);

    // Boundary float multiplication:
    const decimalFactor = m.multiplyBoundary(0.333333);
    expect(decimalFactor.amountMinor).toBe(3333n);
  });
});

describe('Domain: DecimalQuantity (Asset Fractions e.g. BTC via Scaled BigInt)', () => {
  test('preserves high decimal precision up to 8 places backed by BigInt', () => {
    const btc = DecimalQuantity.fromDecimal('0.00034500', 8);
    expect(btc.scale).toBe(8);
    expect(btc.rawUnits).toBe(34500n);
    expect(btc.toCanonicalString()).toBe('0.000345');
  });

  test('handles integer and zero quantities', () => {
    const zero = DecimalQuantity.zero();
    expect(zero.isZero()).toBe(true);
    expect(zero.toCanonicalString()).toBe('0');
  });

  test('performs exact addition and subtraction without IEEE-754 precision loss', () => {
    const q1 = DecimalQuantity.fromDecimal('0.00000001', 8);
    const q2 = DecimalQuantity.fromDecimal('0.00000002', 8);
    const sum = q1.add(q2);
    expect(sum.rawUnits).toBe(3n);
    expect(sum.toCanonicalString()).toBe('0.00000003');

    const diff = sum.subtract(q1);
    expect(diff.rawUnits).toBe(2n);
    expect(diff.toCanonicalString()).toBe('0.00000002');
  });
});

describe('Domain: Investment Cost Basis & Unrealized P/L', () => {
  test('updates weighted average price (PMP) and total cost basis on purchases with pure BigInt rational math', () => {
    let position = {
      quantity: DecimalQuantity.zero(8),
      totalCostBasis: Money.zero('BRL', 2),
      unitAveragePrice: Money.zero('BRL', 2),
    };

    // Purchase 1: 10 units at R$ 20,00 each
    position = updateCostBasisOnPurchase(
      position,
      DecimalQuantity.fromDecimal('10', 8),
      Money.fromDecimal('20.00', 'BRL', 2),
    );
    expect(position.quantity.toCanonicalString()).toBe('10');
    expect(position.totalCostBasis.toDecimalString()).toBe('200.00');
    expect(position.unitAveragePrice.toDecimalString()).toBe('20.00');

    // Purchase 2: 10 units at R$ 30,00 each
    position = updateCostBasisOnPurchase(
      position,
      DecimalQuantity.fromDecimal('10', 8),
      Money.fromDecimal('30.00', 'BRL', 2),
    );
    expect(position.quantity.toCanonicalString()).toBe('20');
    expect(position.totalCostBasis.toDecimalString()).toBe('500.00');
    expect(position.unitAveragePrice.toDecimalString()).toBe('25.00');
  });

  test('reduces total cost basis proportionally on sale while preserving unit average price', () => {
    let position = {
      quantity: DecimalQuantity.fromDecimal('20', 8),
      totalCostBasis: Money.fromDecimal('500.00', 'BRL', 2),
      unitAveragePrice: Money.fromDecimal('25.00', 'BRL', 2),
    };

    // Sell 5 units
    position = updateCostBasisOnSale(position, DecimalQuantity.fromDecimal('5', 8));
    expect(position.quantity.toCanonicalString()).toBe('15');
    expect(position.totalCostBasis.toDecimalString()).toBe('375.00');
    expect(position.unitAveragePrice.toDecimalString()).toBe('25.00'); // PMP unchanged on sale!
  });

  test('rejects purchase and sale with quantity less than or equal to zero', () => {
    const position = {
      quantity: DecimalQuantity.fromDecimal('10', 8),
      totalCostBasis: Money.fromDecimal('200.00', 'BRL', 2),
      unitAveragePrice: Money.fromDecimal('20.00', 'BRL', 2),
    };

    // Negative sale
    expect(() => updateCostBasisOnSale(position, DecimalQuantity.fromDecimal('-5', 8))).toThrow(
      'Invalid sold quantity',
    );
    // Zero sale
    expect(() => updateCostBasisOnSale(position, DecimalQuantity.zero(8))).toThrow(
      'Invalid sold quantity',
    );

    // Negative purchase
    expect(() =>
      updateCostBasisOnPurchase(
        position,
        DecimalQuantity.fromDecimal('-1', 8),
        Money.fromDecimal('20.00', 'BRL', 2),
      ),
    ).toThrow('Invalid purchase quantity');
    // Zero purchase
    expect(() =>
      updateCostBasisOnPurchase(position, DecimalQuantity.zero(8), Money.fromDecimal('20.00', 'BRL', 2)),
    ).toThrow('Invalid purchase quantity');
  });

  test('rejects oversell when sold quantity exceeds current position', () => {
    const position = {
      quantity: DecimalQuantity.fromDecimal('10', 8),
      totalCostBasis: Money.fromDecimal('200.00', 'BRL', 2),
      unitAveragePrice: Money.fromDecimal('20.00', 'BRL', 2),
    };

    // Attempting to sell 15 units when holding only 10
    expect(() => updateCostBasisOnSale(position, DecimalQuantity.fromDecimal('15', 8))).toThrow(
      'Oversell rejected: cannot sell 15 units when current position is only 10 units',
    );

    // Attempting to sell 10.00000001 units
    expect(() =>
      updateCostBasisOnSale(position, DecimalQuantity.fromDecimal('10.00000001', 8)),
    ).toThrow('Oversell rejected');
  });

  test('normalizes quantity scales across purchase and sale without IEEE-754 precision drift', () => {
    // Current position with scale 4: 10.0000 units
    const current = {
      quantity: new DecimalQuantity(100000n, 4), // 10.0000
      totalCostBasis: Money.fromDecimal('200.00', 'BRL', 2),
      unitAveragePrice: Money.fromDecimal('20.00', 'BRL', 2),
    };

    // Purchase with scale 8: 5.50000000 units at R$ 26,00
    const updatedPurchase = updateCostBasisOnPurchase(
      current,
      DecimalQuantity.fromDecimal('5.5', 8),
      Money.fromDecimal('26.00', 'BRL', 2),
    );

    // 10 + 5.5 = 15.5 units at aligned scale 8
    expect(updatedPurchase.quantity.scale).toBe(8);
    expect(updatedPurchase.quantity.toCanonicalString()).toBe('15.5');
    // Total cost = 200 + (5.5 * 26 = 143) = 343.00
    expect(updatedPurchase.totalCostBasis.toDecimalString()).toBe('343.00');

    // Sale with scale 2: sell 2.50 units
    const updatedSale = updateCostBasisOnSale(
      updatedPurchase,
      DecimalQuantity.fromDecimal('2.50', 2),
    );
    // 15.5 - 2.5 = 13.0 units at scale 8
    expect(updatedSale.quantity.toCanonicalString()).toBe('13');
    expect(updatedSale.quantity.scale).toBe(8);
    // Average price remains identical
    expect(updatedSale.unitAveragePrice.toDecimalString()).toBe(
      updatedPurchase.unitAveragePrice.toDecimalString(),
    );
  });

  test('validates fees currency and scale against unitPrice before purchase', () => {
    const position = {
      quantity: DecimalQuantity.fromDecimal('10', 8),
      totalCostBasis: Money.fromDecimal('200.00', 'BRL', 2),
      unitAveragePrice: Money.fromDecimal('20.00', 'BRL', 2),
    };

    // Currency mismatch (fees in USD vs unitPrice in BRL)
    expect(() =>
      updateCostBasisOnPurchase(
        position,
        DecimalQuantity.fromDecimal('2', 8),
        Money.fromDecimal('25.00', 'BRL', 2),
        Money.fromDecimal('1.50', 'USD', 2),
      ),
    ).toThrow('Fees currency/scale mismatch');

    // Scale mismatch (fees in scale 3 vs unitPrice in scale 2)
    expect(() =>
      updateCostBasisOnPurchase(
        position,
        DecimalQuantity.fromDecimal('2', 8),
        Money.fromDecimal('25.00', 'BRL', 2),
        Money.fromMinor(150n, 'BRL', 3),
      ),
    ).toThrow('Fees currency/scale mismatch');
  });

  test('calculates unrealized P/L strictly as Current Market Value - Total Cost Basis', () => {
    const totalCostBasis = Money.fromDecimal('375.00', 'BRL', 2);
    const quantity = DecimalQuantity.fromDecimal('15', 8);
    const currentPrice = Money.fromDecimal('35.00', 'BRL', 2);

    const marketValue = calculateMarketValue(quantity, currentPrice);
    expect(marketValue.toDecimalString()).toBe('525.00'); // 15 * 35 = 525

    const pnl = calculateUnrealizedProfitLoss(totalCostBasis, marketValue);
    expect(pnl.toDecimalString()).toBe('150.00'); // 525 - 375 = +150
    expect(pnl.isPositive()).toBe(true);
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

    // Transition to CANCELLED
    const hashCancelled = calculateCanonicalFingerprint({
      ...basePayload,
      status: 'CANCELLED',
    });
    expect(hashCancelled).toHaveLength(64);
    expect(hashCancelled).not.toBe(hashPending);
    expect(hashCancelled).not.toBe(hashPosted);

    // Transition to VOIDED
    const hashVoided = calculateCanonicalFingerprint({
      ...basePayload,
      status: 'VOIDED',
    });
    expect(hashVoided).toHaveLength(64);
    expect(hashVoided).not.toBe(hashCancelled);

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
    expect(closings).toContain('operatingSurplus');
    expect(closings).toContain('savingsAndInvestments');
    expect(closings).toContain('essentialExpenses');
    expect(closings).toContain('discretionaryExpenses');
    expect(closings).toContain('investmentYield');
    expect(closings).toContain('netWorthChange');

    const investments = TARGET_CONTRACT.NOTION_DS_INVESTMENTS.properties.map((p) => p.domainField);
    expect(investments).toContain('unitAveragePrice');
    expect(investments).toContain('totalCostBasis');
    expect(investments).toContain('unrealizedProfitLoss');

    const syncLog = TARGET_CONTRACT.NOTION_DS_SYNC_LOG.properties.map((p) => p.domainField);
    expect(syncLog).toContain('runId');
    expect(syncLog).toContain('errorCode');
    expect(syncLog).toContain('sanitizedErrorMessage');
    expect(syncLog).toContain('privateLogRef');
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
    expect(fixedBills).toContain('generateObligation');
    expect(fixedBills).toContain('notes');

    // Fechamentos Mensais new fields
    expect(closings).toContain('reconciliationStatus');
    expect(closings).toContain('dataQualityScore');
    expect(closings).toContain('fixedBillsPaidCount');
    expect(closings).toContain('fixedBillsPendingCount');
    expect(closings).toContain('itemsNeedingReviewCount');
    expect(closings).toContain('closedAt');

    // Investimentos new fields
    expect(investments).toContain('currency');
    expect(investments).toContain('liquidity');
    expect(investments).toContain('valuationSource');
    expect(investments).toContain('valuationDate');
    expect(investments).toContain('includeInNetWorth');
    expect(investments).toContain('institution');
    expect(investments).toContain('sourceAssetId');

    // Sync Log new fields
    expect(syncLog).toContain('syncSource');
    expect(syncLog).toContain('errorsCount');
    expect(syncLog).toContain('durationMs');
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

  test('calculateBillDiscrepancy calculates unexplained residual difference exactly', () => {
    const billAmount = Money.fromDecimal('1500.00');
    const purchases = Money.fromDecimal('1200.00');
    const additional = Money.fromDecimal('300.00'); // IOF + installments + charges

    // Fully explained: discrepancy is exactly 0
    const discrepancyZero = calculateBillDiscrepancy(billAmount, purchases, additional);
    expect(discrepancyZero.isZero()).toBe(true);
    expect(discrepancyZero.amountMinor).toBe(0n);

    // Partially explained: 1500 - 1200 - 250 = 50 unexplained
    const discrepancyUnexplained = calculateBillDiscrepancy(
      billAmount,
      purchases,
      Money.fromDecimal('250.00'),
    );
    expect(discrepancyUnexplained.amountMinor).toBe(5000n);
    expect(discrepancyUnexplained.toDecimalString()).toBe('50.00');
  });
});

describe('Notion: Schema Validator (Phase 0 Introspector)', () => {
  test('handles missing environment IDs gracefully and reports UNVERIFIED (never MISSING)', async () => {
    const validator = new NotionSchemaValidator(); // Offline mode
    const report = await validator.runIntrospection({});

    expect(report.totalCanonical).toBe(13);
    expect(report.expectedExisting).toBe(12);
    expect(report.configuredCount).toBe(0);
    expect(report.verifiedCount).toBe(0);
    expect(report.failedCount).toBe(12);

    // NOTION_DS_CARD_BILLS is marked as PROPOSED_NEW_DATABASE with PROPOSED_TO_CREATE properties
    expect(report.results.NOTION_DS_CARD_BILLS.status).toBe('PROPOSED_NEW_DATABASE');
    expect(report.results.NOTION_DS_CARD_BILLS.properties[0].status).toBe('PROPOSED_TO_CREATE');

    // Existing ones are marked as MISSING_ENV_ID with UNVERIFIED properties (never MISSING)
    expect(report.results.NOTION_DS_ACCOUNTS.status).toBe('MISSING_ENV_ID');
    expect(report.results.NOTION_DS_ACCOUNTS.properties[0].status).toBe('UNVERIFIED');
    expect(report.results.NOTION_DS_TRANSACTIONS.status).toBe('MISSING_ENV_ID');
    expect(report.results.NOTION_DS_TRANSACTIONS.properties[0].status).toBe('UNVERIFIED');
  });

  test('classifies properties into EXACT_MATCH, RENAME_CANDIDATE, RENAME_TYPE_MISMATCH, TYPE_MISMATCH, MISSING, EXTRA_PRESERVE', () => {
    const validator = new NotionSchemaValidator();
    const contract = TARGET_CONTRACT.NOTION_DS_CATEGORIES; // expected: Nome da Categoria (title), Grupo Orçamentário (select), Variabilidade (select), Natureza Padrão (select)

    const actualNotionProps = {
      'Nome da Categoria': { type: 'title' },           // EXACT_MATCH
      'Grupo Orçamentário': { type: 'multi_select' },   // TYPE_MISMATCH (expected select)
      'Variabilidade da Despesa': { type: 'select' },   // RENAME_CANDIDATE (for Variabilidade, same type)
      // Natureza Padrão is missing                     // MISSING
      'Cor da Tag': { type: 'select' },                 // EXTRA_PRESERVE
    };

    const diffs = validator.compareProperties(contract, actualNotionProps);

    const exact = diffs.find((d) => d.notionProperty === 'Nome da Categoria');
    expect(exact?.status).toBe('EXACT_MATCH');

    const typeMismatch = diffs.find((d) => d.notionProperty === 'Grupo Orçamentário');
    expect(typeMismatch?.status).toBe('TYPE_MISMATCH');

    const renameCandidate = diffs.find((d) => d.notionProperty === 'Variabilidade');
    expect(renameCandidate?.status).toBe('RENAME_CANDIDATE');
    expect(renameCandidate?.candidateName).toBe('Variabilidade da Despesa');

    const missing = diffs.find((d) => d.notionProperty === 'Natureza Padrão');
    expect(missing?.status).toBe('MISSING');

    const extra = diffs.find((d) => d.notionProperty === 'Cor da Tag');
    expect(extra?.status).toBe('EXTRA_PRESERVE');
    expect(extra?.authority).toBe('USUARIO');
  });

  test('distinguishes RENAME_TYPE_MISMATCH when candidate exists but type is incompatible', () => {
    const validator = new NotionSchemaValidator();
    const contract = TARGET_CONTRACT.NOTION_DS_CATEGORIES;

    const actualNotionProps = {
      'Nome da Categoria': { type: 'title' },
      'Grupo Orçamentário': { type: 'select' },
      // Variabilidade expected select, but Notion has rich_text
      'Variabilidade da Conta': { type: 'rich_text' },
    };

    const diffs = validator.compareProperties(contract, actualNotionProps);
    const renameMismatch = diffs.find((d) => d.notionProperty === 'Variabilidade');
    expect(renameMismatch?.status).toBe('RENAME_TYPE_MISMATCH');
    expect(renameMismatch?.candidateName).toBe('Variabilidade da Conta');
  });

  test('enforces precedence: exact name > explicit alias > heuristic suggestion', () => {
    const validator = new NotionSchemaValidator();
    const contract = TARGET_CONTRACT.NOTION_DS_CATEGORIES;

    const actualNotionProps = {
      // Tier 1: exact name matches 'Nome da Categoria'
      'Nome da Categoria': { type: 'title' },
      // Tier 2: explicit alias 'Grupo 50/30/20' takes precedence for 'Grupo Orçamentário'
      'Grupo 50/30/20': { type: 'select' },
      'Grupo Orçamentário Velho': { type: 'select' },
      // Tier 3: fuzzy suggestion for 'Natureza Padrão' (no exact match, no alias match)
      'Natureza de Operação': { type: 'select' },
    };

    const diffs = validator.compareProperties(contract, actualNotionProps);

    // Exact match
    const exact = diffs.find((d) => d.notionProperty === 'Nome da Categoria');
    expect(exact?.status).toBe('EXACT_MATCH');

    // Explicit alias match takes precedence over any heuristic similarity:
    const aliasCandidate = diffs.find((d) => d.notionProperty === 'Grupo Orçamentário');
    expect(aliasCandidate?.status).toBe('RENAME_CANDIDATE');
    expect(aliasCandidate?.candidateName).toBe('Grupo 50/30/20');

    // Heuristic match is strictly non-authoritative:
    const heuristic = diffs.find((d) => d.notionProperty === 'Natureza Padrão');
    expect(heuristic?.status).toBe('HEURISTIC_SUGGESTION');
    expect(heuristic?.candidateName).toBe('Natureza de Operação');
    expect(heuristic?.description).toContain('não-autoritativa');

    // Properties not consumed by exact or alias matches are preserved in EXTRA_PRESERVE:
    const extraNames = diffs.filter((d) => d.status === 'EXTRA_PRESERVE').map((d) => d.notionProperty);
    expect(extraNames).toContain('Grupo Orçamentário Velho');
    expect(extraNames).toContain('Natureza de Operação');
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

