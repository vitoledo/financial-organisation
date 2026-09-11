import crypto from 'crypto';

// =============================================================================
// DOMAIN TYPES: CANONICAL VALUE OBJECTS & PRECISION
// =============================================================================

/**
 * Value Object representing exact monetary values without IEEE 754 floating point issues.
 * Generic by currency and scale (minor units).
 * Defaults to BRL with scale 2 (centavos: R$ 15,00 = 1500n).
 * Can represent any currency/scale (e.g. JPY with scale 0, BHD with scale 3).
 */
const VALID_DECIMAL_STRING_REGEX = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

function parseValidatedDecimalString(
  value: string,
  typeName: string,
  scale: number,
): { isNeg: boolean; absInt: bigint; decPart: string } {
  if (typeof value !== 'string') {
    throw new TypeError(
      `${typeName}.fromDecimal requires an exact string representation to avoid IEEE-754 precision loss (received ${typeof value}: ${value}). For boundary float numbers, use ${typeName}.fromDecimalBoundary(number).`,
    );
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 20) {
    throw new Error(`Invalid scale: ${scale}. Scale must be an integer between 0 and 20.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`Invalid decimal string: empty string.`);
  }
  if (!VALID_DECIMAL_STRING_REGEX.test(trimmed)) {
    throw new Error(`Invalid decimal string: "${value}". Must be a valid numeric decimal representation.`);
  }

  const clean = trimmed.replace(',', '.');
  const isNeg = clean.startsWith('-');
  const unsigned = clean.startsWith('-') || clean.startsWith('+') ? clean.slice(1) : clean;
  const parts = unsigned.split('.');
  if (parts.length > 2) {
    throw new Error(`Invalid decimal string with multiple decimal points: "${value}"`);
  }
  const [intPartRaw = '', decPart = ''] = parts;
  const intPart = intPartRaw === '' ? '0' : intPartRaw;
  const absInt = BigInt(intPart);

  return { isNeg, absInt, decPart };
}

export class Money {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly scale: number;

  constructor(amountMinor: bigint, currency: string = 'BRL', scale: number = 2) {
    if (typeof amountMinor !== 'bigint') {
      throw new TypeError(`amountMinor must be a bigint, received ${typeof amountMinor}`);
    }
    if (typeof currency !== 'string' || currency.trim() === '') {
      throw new Error('Invalid currency: currency must be a non-empty string.');
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > 20) {
      throw new Error(`Invalid scale: ${scale}. Scale must be an integer between 0 and 20.`);
    }
    this.amountMinor = amountMinor;
    this.currency = currency.trim().toUpperCase();
    this.scale = scale;
  }

  static fromMinor(amountMinor: bigint | number, currency: string = 'BRL', scale: number = 2): Money {
    if (typeof currency !== 'string' || currency.trim() === '') {
      throw new Error('Invalid currency: currency must be a non-empty string.');
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > 20) {
      throw new Error(`Invalid scale: ${scale}. Scale must be an integer between 0 and 20.`);
    }
    if (typeof amountMinor === 'number') {
      if (!Number.isSafeInteger(amountMinor)) {
        throw new Error(
          `Invalid non-safe-integer minor amount: ${amountMinor}. fromMinor(number) requires a safe integer.`,
        );
      }
      return new Money(BigInt(amountMinor), currency, scale);
    }
    return new Money(amountMinor, currency, scale);
  }

  static fromCents(cents: bigint | number, currency: string = 'BRL'): Money {
    return Money.fromMinor(cents, currency, 2);
  }

  /**
   * Canonical creation of Money from an exact decimal string representation (e.g. "1250.50" or "1.005").
   * Strictly requires string to prevent IEEE-754 floating point distortion.
   * Performs exact half-up rounding if decimal places exceed target scale.
   * Validates scale and rejects invalid numeric strings (e.g. "1.2.3", empty string, non-numeric).
   */
  static fromDecimal(value: string, currency: string = 'BRL', scale: number = 2): Money {
    if (typeof currency !== 'string' || currency.trim() === '') {
      throw new Error('Invalid currency: currency must be a non-empty string.');
    }
    const { isNeg, absInt, decPart } = parseValidatedDecimalString(value, 'Money', scale);
    const targetScaleFactor = 10n ** BigInt(scale);

    let absDecMinor = 0n;
    if (decPart.length > 0) {
      if (decPart.length <= scale) {
        const paddedDec = (decPart + '0'.repeat(scale)).slice(0, scale);
        absDecMinor = BigInt(paddedDec);
      } else {
        // More decimal places than target scale: exact half-up rounding in BigInt!
        const decVal = BigInt(decPart);
        const excessScale = BigInt(decPart.length - scale);
        const divisor = 10n ** excessScale;
        absDecMinor = (decVal + divisor / 2n) / divisor;
      }
    }

    const absMinor = absInt * targetScaleFactor + absDecMinor;
    const minor = isNeg ? -absMinor : absMinor;
    return new Money(minor, currency, scale);
  }

  /**
   * Boundary conversion for external floats (e.g. JSON payloads or Notion SDK).
   */
  static fromDecimalBoundary(value: number | string, currency: string = 'BRL', scale: number = 2): Money {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Invalid non-finite money amount: ${value}`);
      return Money.fromDecimal(value.toFixed(scale + 4), currency, scale);
    }
    return Money.fromDecimal(value, currency, scale);
  }

  static zero(currency: string = 'BRL', scale: number = 2): Money {
    return new Money(0n, currency, scale);
  }

  add(other: Money): Money {
    this.assertSameCurrencyAndScale(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency, this.scale);
  }

  subtract(other: Money): Money {
    this.assertSameCurrencyAndScale(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency, this.scale);
  }

  negate(): Money {
    return new Money(-this.amountMinor, this.currency, this.scale);
  }

  abs(): Money {
    return new Money(this.amountMinor < 0n ? -this.amountMinor : this.amountMinor, this.currency, this.scale);
  }

  multiply(factor: bigint): Money {
    return new Money(this.amountMinor * factor, this.currency, this.scale);
  }

  multiplyRational(numerator: bigint, denominator: bigint): Money {
    if (denominator === 0n) throw new Error('Division by zero in multiplyRational');
    const sign = (this.amountMinor * numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
    const absProd = this.amountMinor * numerator < 0n ? -(this.amountMinor * numerator) : this.amountMinor * numerator;
    const absDenom = denominator < 0n ? -denominator : denominator;
    const roundedAbs = (absProd + (absDenom / 2n)) / absDenom;
    return new Money(sign * roundedAbs, this.currency, this.scale);
  }

  multiplyBoundary(factor: number): Money {
    if (!Number.isFinite(factor)) throw new Error(`Invalid non-finite factor: ${factor}`);
    if (Number.isInteger(factor) && Number.isSafeInteger(factor)) {
      return this.multiply(BigInt(factor));
    }
    const factorStr = factor.toFixed(8).replace(/\.?0+$/, '');
    const isNeg = factorStr.startsWith('-');
    const unsigned = isNeg ? factorStr.slice(1) : factorStr;
    const [fInt, fDec = ''] = unsigned.split('.');
    const denom = 10n ** BigInt(fDec.length);
    const num = (isNeg ? -1n : 1n) * (BigInt(fInt || '0') * denom + BigInt(fDec || '0'));
    return this.multiplyRational(num, denom);
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  isPositive(): boolean {
    return this.amountMinor > 0n;
  }

  isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.scale === other.scale &&
      this.amountMinor === other.amountMinor
    );
  }

  toDecimal(): number {
    const scaleFactor = Number(10n ** BigInt(this.scale));
    return Number(this.amountMinor) / scaleFactor;
  }

  toDecimalString(): string {
    if (this.scale === 0) {
      return this.amountMinor.toString();
    }
    const scaleFactor = 10n ** BigInt(this.scale);
    const isNeg = this.amountMinor < 0n;
    const absVal = isNeg ? -this.amountMinor : this.amountMinor;
    const intPart = (absVal / scaleFactor).toString();
    const decPart = (absVal % scaleFactor).toString().padStart(this.scale, '0');
    return `${isNeg ? '-' : ''}${intPart}.${decPart}`;
  }

  toFormattedBR(): string {
    const decStr = this.toDecimalString();
    const isNeg = decStr.startsWith('-');
    const clean = isNeg ? decStr.slice(1) : decStr;
    const [intPart, decPart] = clean.split('.');
    const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

    if (this.scale === 0) {
      return `${isNeg ? '-' : ''}${this.currency} ${formattedInt}`;
    }

    const prefix = this.currency === 'BRL' ? 'R$' : this.currency;
    return `${isNeg ? '-' : ''}${prefix} ${formattedInt},${decPart}`;
  }

  private assertSameCurrencyAndScale(other: Money): void {
    if (this.currency !== other.currency || this.scale !== other.scale) {
      throw new Error(
        `Currency/scale mismatch: ${this.currency} (scale ${this.scale}) vs ${other.currency} (scale ${other.scale})`,
      );
    }
  }
}

/**
 * Value Object for asset quantities requiring arbitrary high precision (e.g. BTC up to 8 decimal places).
 * Fully exact rational/scaled representation backed by BigInt, eliminating IEEE-754 precision drift.
 */
export class DecimalQuantity {
  readonly rawUnits: bigint;
  readonly scale: number;

  constructor(rawUnits: bigint, scale: number = 8) {
    if (typeof rawUnits !== 'bigint') {
      throw new TypeError(`rawUnits must be a bigint, received ${typeof rawUnits}`);
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > 20) {
      throw new Error(`Invalid scale: ${scale}. Scale must be an integer between 0 and 20.`);
    }
    this.rawUnits = rawUnits;
    this.scale = scale;
  }

  /**
   * Canonical creation of DecimalQuantity from exact string representation.
   * Strictly requires string to prevent IEEE-754 precision loss.
   * Performs exact half-up rounding if decimal places exceed target scale.
   * Validates scale and rejects invalid numeric strings (e.g. "1.2.3", empty string, non-numeric).
   */
  static fromDecimal(value: string, scale: number = 8): DecimalQuantity {
    const { isNeg, absInt, decPart } = parseValidatedDecimalString(value, 'DecimalQuantity', scale);
    const targetScaleFactor = 10n ** BigInt(scale);

    let absDecUnits = 0n;
    if (decPart.length > 0) {
      if (decPart.length <= scale) {
        const paddedDec = (decPart + '0'.repeat(scale)).slice(0, scale);
        absDecUnits = BigInt(paddedDec);
      } else {
        const decVal = BigInt(decPart);
        const excessScale = BigInt(decPart.length - scale);
        const divisor = 10n ** excessScale;
        absDecUnits = (decVal + divisor / 2n) / divisor;
      }
    }

    const absUnits = absInt * targetScaleFactor + absDecUnits;
    const rawUnits = isNeg ? -absUnits : absUnits;
    return new DecimalQuantity(rawUnits, scale);
  }

  static fromDecimalBoundary(value: number | string, scale: number = 8): DecimalQuantity {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Invalid non-finite quantity: ${value}`);
      return DecimalQuantity.fromDecimal(value.toFixed(scale + 4), scale);
    }
    return DecimalQuantity.fromDecimal(value, scale);
  }

  static fromRawUnits(rawUnits: bigint, scale: number = 8): DecimalQuantity {
    if (!Number.isInteger(scale) || scale < 0 || scale > 20) {
      throw new Error(`Invalid scale: ${scale}. Scale must be an integer between 0 and 20.`);
    }
    return new DecimalQuantity(rawUnits, scale);
  }

  static zero(scale: number = 8): DecimalQuantity {
    return new DecimalQuantity(0n, scale);
  }

  add(other: DecimalQuantity): DecimalQuantity {
    const aligned = this.alignScale(other);
    return new DecimalQuantity(aligned.a + aligned.b, aligned.scale);
  }

  subtract(other: DecimalQuantity): DecimalQuantity {
    const aligned = this.alignScale(other);
    return new DecimalQuantity(aligned.a - aligned.b, aligned.scale);
  }

  isZero(): boolean {
    return this.rawUnits === 0n;
  }

  isPositive(): boolean {
    return this.rawUnits > 0n;
  }

  isNegative(): boolean {
    return this.rawUnits < 0n;
  }

  equals(other: DecimalQuantity): boolean {
    const aligned = this.alignScale(other);
    return aligned.a === aligned.b;
  }

  toCanonicalString(): string {
    if (this.scale === 0) return this.rawUnits.toString();
    const scaleFactor = 10n ** BigInt(this.scale);
    const isNeg = this.rawUnits < 0n;
    const absVal = isNeg ? -this.rawUnits : this.rawUnits;
    const intPart = (absVal / scaleFactor).toString();
    const decPart = (absVal % scaleFactor).toString().padStart(this.scale, '0');
    const cleanDec = decPart.replace(/0+$/, '');
    return `${isNeg ? '-' : ''}${intPart}${cleanDec ? '.' + cleanDec : ''}`;
  }

  // Serialization / UI display boundary only:
  toNumber(): number {
    const scaleFactor = Number(10n ** BigInt(this.scale));
    return Number(this.rawUnits) / scaleFactor;
  }

  private alignScale(other: DecimalQuantity): { a: bigint; b: bigint; scale: number } {
    if (this.scale === other.scale) {
      return { a: this.rawUnits, b: other.rawUnits, scale: this.scale };
    }
    const maxScale = Math.max(this.scale, other.scale);
    const aFactor = 10n ** BigInt(maxScale - this.scale);
    const bFactor = 10n ** BigInt(maxScale - other.scale);
    return { a: this.rawUnits * aFactor, b: other.rawUnits * bFactor, scale: maxScale };
  }
}

// =============================================================================
// IDEMPOTENCY IDENTIFIER & VERSION FINGERPRINT
// =============================================================================

/**
 * Canonical Idempotent Transaction Identity.
 * The TRUE unique key in storage: UNIQUE(source, source_account_id, source_transaction_id).
 */
export interface TransactionIdempotencyKey {
  source: string;
  sourceAccountId: string;
  sourceTransactionId: string;
}

export function buildTransactionIdempotencyKey(key: TransactionIdempotencyKey): string {
  return `${key.source}:${key.sourceAccountId}:${key.sourceTransactionId}`;
}

/**
 * Canonical Version Fingerprint (SHA-256 64-hex string).
 * Strictly represents the state/version of the payload, NOT the unique key!
 */
export function calculateCanonicalFingerprint(payload: {
  source: string;
  sourceAccountId: string;
  sourceTransactionId: string;
  amountMinor: bigint;
  currency: string;
  scale: number;
  dateIso: string;
  status: string;
  description: string;
  rawCategory: string;
  direction: string;
}): string {
  const canonicalObj = {
    amountMinor: payload.amountMinor.toString(),
    currency: payload.currency.toUpperCase(),
    dateIso: new Date(payload.dateIso).toISOString(),
    description: payload.description.trim(),
    direction: payload.direction.toUpperCase(),
    rawCategory: payload.rawCategory.trim(),
    scale: payload.scale,
    source: payload.source.toUpperCase(),
    sourceAccountId: payload.sourceAccountId.trim(),
    sourceTransactionId: payload.sourceTransactionId.trim(),
    status: payload.status.toUpperCase(),
  };

  const canonicalString = JSON.stringify(canonicalObj, Object.keys(canonicalObj).sort());
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

/**
 * HMAC-based sensitive fingerprint for matching PII (e.g. CPF/CNPJ) without exposing raw PII.
 * Uses a dedicated 256-bit secret key (AUDIT_HMAC_SECRET_KEY).
 */
export function calculateSensitiveHmac(value: string | null | undefined, secretKey: string): string | null {
  if (!value) return null;
  const normalized = value.replace(/\D/g, ''); // Digits only
  if (!normalized) return null;
  return crypto.createHmac('sha256', secretKey).update(normalized, 'utf8').digest('hex');
}

// =============================================================================
// ENCRYPTION (AES-256-GCM) FOR PRIVATE PERSISTENCE & AUDIT
// =============================================================================

export interface EncryptedEnvelope {
  keyVersion: number;
  iv: string;         // Base64 (12 bytes nonce)
  authTag: string;    // Base64 (16 bytes auth tag)
  ciphertext: string; // Base64
}

export class EncryptionService {
  private readonly key: Buffer;
  private readonly keyVersion: number;

  constructor(key: Buffer, keyVersion: number = 1) {
    if (key.length !== 32) {
      throw new Error(`AES-256-GCM requires exactly 32 bytes (256 bits). Received ${key.length} bytes.`);
    }
    this.key = key;
    this.keyVersion = keyVersion;
  }

  static generateRandomKey(): Buffer {
    return crypto.randomBytes(32);
  }

  encrypt(plaintext: string | Buffer): EncryptedEnvelope {
    const iv = crypto.randomBytes(12); // 96-bit nonce standard for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const dataBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');

    const encrypted = Buffer.concat([cipher.update(dataBuf), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      keyVersion: this.keyVersion,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
  }

  decrypt(envelope: EncryptedEnvelope): Buffer {
    if (envelope.keyVersion !== this.keyVersion) {
      throw new Error(`Key version mismatch: expected ${this.keyVersion}, received ${envelope.keyVersion}`);
    }

    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  decryptToString(envelope: EncryptedEnvelope): string {
    return this.decrypt(envelope).toString('utf8');
  }
}

// =============================================================================
// MULTIDIMENSIONAL DOMAIN ENUMS
// =============================================================================

export type FlowDirection = 'INFLOW' | 'OUTFLOW';

/**
 * Strictly budgetary impact dimension:
 * - INCOME: expands spending capacity
 * - EXPENSE: consumes monthly spending budget
 * - REVERSAL: voids/refunds previous income or expense
 * - NEUTRAL: no impact on operating budget (e.g. transfers, capital contributions, debt principal, credit card settlement)
 */
export type BudgetEffect = 'INCOME' | 'EXPENSE' | 'REVERSAL' | 'NEUTRAL';

/**
 * Accounting and economic nature of the operation.
 * Distinguishes debt principal amortization from interest charges.
 */
export type EconomicNature =
  | 'OPERATING_REVENUE'           // Active income: salary, freelance, pro-labore
  | 'OPERATING_EXPENSE'           // Living expenses / consumption
  | 'INTERNAL_TRANSFER'           // Movement between own accounts
  | 'CAPITAL_CONTRIBUTION'        // Sending funds to investment environment
  | 'CAPITAL_WITHDRAWAL'          // Retracting funds from investment to checking
  | 'ASSET_PURCHASE'              // Executing purchase of asset
  | 'ASSET_SALE'                  // Executing disposal of asset
  | 'YIELD_DIVIDEND'              // Dividends, coupons, yield
  | 'DEBT_PRINCIPAL_AMORTIZATION' // Principal debt repayment (reduces liability)
  | 'DEBT_INTEREST_CHARGES'       // Interest, finance charges, IOF on debt (financial expense)
  | 'CREDIT_CARD_SETTLEMENT'      // Credit card bill full/partial settlement
  | 'REIMBURSEMENT'               // Refund / reimbursement
  | 'ACCOUNTING_ADJUSTMENT';      // Balancing entry

/**
 * Allocation purpose when moving money between accounts.
 */
export type AllocationPurpose =
  | 'OPERATIONAL_CASH'
  | 'INVESTMENT_RESERVE'          // Money reserved for future asset buying (e.g. Nubank -> Mercado Pago)
  | 'EMERGENCY_FUND'
  | 'GENERAL_SAVINGS';

export type TransactionBankStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'POSTED'
  | 'CANCELLED'
  | 'VOIDED';

export type ReviewStatus =
  | 'AUTO_CONFIRMED'
  | 'PROBABLE'
  | 'NEEDS_REVIEW'
  | 'MANUALLY_CONFIRMED'
  | 'LEGACY_UNVERIFIED';

export type BillStatus =
  | 'ABERTA_EM_CURSO'
  | 'FECHADA_A_VENCER'
  | 'VENCIDA'
  | 'PAGA_INTEGRAL'
  | 'PAGA_PARCIAL';

export type CycleType =
  | 'CICLO_REAL_BANCO'
  | 'CICLO_CONFIGURADO'
  | 'CICLO_ESTIMADO';

// =============================================================================
// DOMAIN ENTITIES: GENERIC ACCOUNT & TRANSACTION
// Decoupled from upstream proprietary identifiers (Pierre).
// Canonical identity: source, sourceAccountId, sourceTransactionId, currency.
// Fully compatible with UNIQUE(source, source_account_id, source_transaction_id).
// =============================================================================

export interface AccountDomainEntity {
  id?: string;
  name: string;
  source: string;                  // Generic source connector (e.g. 'PIERRE', 'MANUAL')
  sourceAccountId: string;         // Unique account ID in source system
  currency: string;                // ISO currency code (e.g. 'BRL', 'USD')
  institution: string;             // Banking entity (e.g. 'Nubank', 'Mercado Pago')
  type: string;                    // CHECKING_ACCOUNT, CREDIT_CARD, etc.
  balance: Money;
  contractedCreditLimit?: Money;
  customizedCreditLimit?: Money;
  availableCreditLimit?: Money;
  usedOperationalLimit?: Money;
  rawUsedCreditLimit?: Money;
  closingDay?: number;
  dueDay?: number;
  includeInCash: boolean;
  includeInNetWorth: boolean;
  lastSyncedAt?: string;
}

export interface TransactionDomainEntity {
  id?: string;
  source: string;                  // Generic source connector (e.g. 'PIERRE', 'MANUAL')
  sourceAccountId: string;         // Unique account ID in source system
  sourceTransactionId: string;     // Unique transaction ID in source system
  currency: string;                // ISO currency code (e.g. 'BRL', 'USD')
  canonicalHash: string;           // SHA-256 version fingerprint
  description: string;
  date: string;                    // ISO-8601
  amount: Money;
  rawAmount?: Money;
  flowDirection: FlowDirection;
  economicNature: EconomicNature;
  budgetEffect: BudgetEffect;
  allocationPurpose?: AllocationPurpose;
  savingsGoalContribution?: Money;
  accountRelationId?: string;
  categoryRelationId?: string;
  billRelationId?: string;
  bankStatus: TransactionBankStatus;
  reviewStatus: ReviewStatus;
  reviewReason?: string;
  rawCategory?: string;
  rawDescription?: string;
  counterpartyHmac?: string;
}

// =============================================================================
// CREDIT CARD BILL DOMAIN MODEL (MULTIPLE PAYMENTS & ADDITIONAL COMPONENTS)
// =============================================================================

export interface CardBill {
  id?: string;
  accountId: string;
  cycleType: CycleType;
  status: BillStatus;
  closingDate?: string;
  dueDate: string;
  rawBillAmount: Money;
  purchasesTotal: Money;
  /**
   * Sum of identified additional components on the statement (e.g. previous purchase installments,
   * interest/finance charges, IOF, late fees, adjustments, credits/refunds).
   * Strictly represents the sum of identified line items, NOT rawBillAmount - purchasesTotal!
   */
  additionalComponentsAmount: Money;
  /**
   * Unexplained residual discrepancy:
   * unexplainedDiscrepancy = rawBillAmount - purchasesTotal - additionalComponentsAmount.
   */
  unexplainedDiscrepancy: Money;
  paidAmount: Money;
  paidAt?: string;
  transactionIds: string[];
  /**
   * Multiple payment transactions supported (partial payments, advance payments, final settlement).
   */
  paymentTransactionIds: string[];
}

/**
 * Calculates unexplained residual discrepancy in credit card bills:
 * unexplainedDiscrepancy = billAmount - reconciledPurchases - identifiedAdditionalComponents.
 */
export function calculateBillDiscrepancy(
  billAmount: Money,
  reconciledPurchases: Money,
  identifiedAdditionalComponents: Money,
): Money {
  return billAmount.subtract(reconciledPurchases).subtract(identifiedAdditionalComponents);
}

// =============================================================================
// INVESTMENT & PORTFOLIO DOMAIN TYPES
// Note: "Caixa Reservado" is NOT an asset position in Investimentos.
// Money held in bank accounts (e.g. Mercado Pago) reserved for future investment
// is tracked in Contas balance with allocationPurpose = 'INVESTMENT_RESERVE'
// and BudgetEffect = 'NEUTRAL', completely eliminating double-counting.
// =============================================================================

export type InvestmentMovementType =
  | 'CAPITAL_CONTRIBUTION'  // Adding funds to investment custody
  | 'CAPITAL_WITHDRAWAL'    // Withdrawing funds back to checking account
  | 'ASSET_PURCHASE'        // Buying an asset (affects cost basis/PMP)
  | 'ASSET_SALE'            // Selling an asset (realizes P&L)
  | 'YIELD_DIVIDEND'        // Dividends, JCP, yield
  | 'FEE_TAX'               // Brokerage fees, B3 fees, IRRF, IOF
  | 'POSITION_ADJUSTMENT';  // Splitting, reverse splitting, bonus shares

export interface CostBasisTracker {
  quantity: DecimalQuantity;
  totalCostBasis: Money;     // Custo Base Total acumulado
  unitAveragePrice: Money;   // Preço Médio Ponderado Unitário (PMP)
  // Backwards-compatibility aliases:
  totalCost?: Money;
  averagePrice?: Money;
}

export function updateCostBasisOnPurchase(
  current: CostBasisTracker,
  purchaseQuantity: DecimalQuantity,
  unitPrice: Money,
  fees: Money = Money.zero(unitPrice.currency, unitPrice.scale),
): CostBasisTracker {
  // Guardrail 1: reject purchase with quantity <= 0
  if (purchaseQuantity.isZero() || purchaseQuantity.isNegative()) {
    throw new Error(
      `Invalid purchase quantity: ${purchaseQuantity.toCanonicalString()}. Purchase quantity must be strictly greater than zero.`,
    );
  }

  // Guardrail 2: validate fees currency and scale
  if (fees.currency !== unitPrice.currency || fees.scale !== unitPrice.scale) {
    throw new Error(
      `Fees currency/scale mismatch: ${fees.currency} (scale ${fees.scale}) vs unitPrice ${unitPrice.currency} (scale ${unitPrice.scale}). Fees must share identical currency and scale.`,
    );
  }

  // Guardrail 3: normalize scales before any ratio or addition between rawUnits
  const targetQtyScale = Math.max(current.quantity.scale, purchaseQuantity.scale);
  const currentAlignedRaw = current.quantity.rawUnits * (10n ** BigInt(targetQtyScale - current.quantity.scale));
  const purchaseAlignedRaw = purchaseQuantity.rawUnits * (10n ** BigInt(targetQtyScale - purchaseQuantity.scale));
  const newQtyRaw = currentAlignedRaw + purchaseAlignedRaw;
  const newQuantity = new DecimalQuantity(newQtyRaw, targetQtyScale);

  // Exact gross purchase cost using aligned scale
  const qtyScaleFactor = 10n ** BigInt(targetQtyScale);
  const grossCostMinor = (purchaseAlignedRaw * unitPrice.amountMinor + (qtyScaleFactor / 2n)) / qtyScaleFactor;
  const purchaseCost = new Money(grossCostMinor + fees.amountMinor, unitPrice.currency, unitPrice.scale);

  const prevTotalCost = current.totalCostBasis ?? current.totalCost ?? Money.zero(unitPrice.currency, unitPrice.scale);
  const newTotalCostBasis = prevTotalCost.add(purchaseCost);

  // Preço Médio Ponderado Unitário (PMP):
  // newTotalCostBasis.amountMinor is in unitPrice.scale
  // newQtyRaw is in targetQtyScale
  const unitAvgMinor = (newTotalCostBasis.amountMinor * qtyScaleFactor + (newQtyRaw / 2n)) / newQtyRaw;
  const newUnitAvgPrice = new Money(unitAvgMinor, unitPrice.currency, unitPrice.scale);

  return {
    quantity: newQuantity,
    totalCostBasis: newTotalCostBasis,
    unitAveragePrice: newUnitAvgPrice,
    totalCost: newTotalCostBasis,
    averagePrice: newUnitAvgPrice,
  };
}

export function updateCostBasisOnSale(
  current: CostBasisTracker,
  soldQuantity: DecimalQuantity,
): CostBasisTracker {
  // Guardrail 1: reject sale with quantity <= 0
  if (soldQuantity.isZero() || soldQuantity.isNegative()) {
    throw new Error(
      `Invalid sold quantity: ${soldQuantity.toCanonicalString()}. Sold quantity must be strictly greater than zero.`,
    );
  }

  // Guardrail 2: normalize scales before any comparison or ratio
  const commonScale = Math.max(current.quantity.scale, soldQuantity.scale);
  const currentRaw = current.quantity.rawUnits * (10n ** BigInt(commonScale - current.quantity.scale));
  const soldRaw = soldQuantity.rawUnits * (10n ** BigInt(commonScale - soldQuantity.scale));

  // Guardrail 3: reject oversell (sold > current)
  if (soldRaw > currentRaw) {
    throw new Error(
      `Oversell rejected: cannot sell ${soldQuantity.toCanonicalString()} units when current position is only ${current.quantity.toCanonicalString()} units.`,
    );
  }

  const currentTotalCost = current.totalCostBasis ?? current.totalCost ?? Money.zero();
  const currentAvgPrice = current.unitAveragePrice ?? current.averagePrice ?? Money.zero();
  const remainingRaw = currentRaw - soldRaw;

  if (remainingRaw === 0n) {
    const zeroCost = Money.zero(currentTotalCost.currency, currentTotalCost.scale);
    return {
      quantity: DecimalQuantity.zero(commonScale),
      totalCostBasis: zeroCost,
      unitAveragePrice: currentAvgPrice,
      totalCost: zeroCost,
      averagePrice: currentAvgPrice,
    };
  }

  // Selling reduces total cost proportionally:
  // remainingCostMinor = (currentTotalCost.amountMinor * remainingRaw + currentRaw / 2n) / currentRaw
  const remainingCostMinor =
    (currentTotalCost.amountMinor * remainingRaw + (currentRaw / 2n)) / currentRaw;
  const remainingTotalCost = new Money(remainingCostMinor, currentTotalCost.currency, currentTotalCost.scale);

  return {
    quantity: new DecimalQuantity(remainingRaw, commonScale),
    totalCostBasis: remainingTotalCost,
    unitAveragePrice: currentAvgPrice,
    totalCost: remainingTotalCost,
    averagePrice: currentAvgPrice,
  };
}

/**
 * Canonical calculation of unrealized P/L:
 * Unrealized P/L = Current Market Value - Total Cost Basis.
 * Strictly separates Preço Médio Unitário from Custo Base Total.
 */
export function calculateUnrealizedProfitLoss(
  totalCostBasis: Money,
  currentMarketValue: Money,
): Money {
  return currentMarketValue.subtract(totalCostBasis);
}

/**
 * Calculates current market value from quantity and current unit market price using exact rational math.
 */
export function calculateMarketValue(
  quantity: DecimalQuantity,
  currentUnitPrice: Money,
): Money {
  const qtyScaleFactor = 10n ** BigInt(quantity.scale);
  const marketValueMinor =
    (quantity.rawUnits * currentUnitPrice.amountMinor + (qtyScaleFactor / 2n)) / qtyScaleFactor;
  return new Money(marketValueMinor, currentUnitPrice.currency, currentUnitPrice.scale);
}
