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
export class Money {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly scale: number;

  constructor(amountMinor: bigint, currency: string = 'BRL', scale: number = 2) {
    this.amountMinor = amountMinor;
    this.currency = currency.toUpperCase();
    this.scale = scale;
  }

  static fromMinor(amountMinor: bigint | number, currency: string = 'BRL', scale: number = 2): Money {
    return new Money(BigInt(Math.round(Number(amountMinor))), currency, scale);
  }

  static fromCents(cents: bigint | number, currency: string = 'BRL'): Money {
    return Money.fromMinor(cents, currency, 2);
  }

  static fromDecimal(value: number | string, currency: string = 'BRL', scale: number = 2): Money {
    const scaleFactor = 10n ** BigInt(scale);

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Invalid non-finite money amount: ${value}`);
      const minor = Math.round(value * Number(scaleFactor));
      return new Money(BigInt(minor), currency, scale);
    }

    const clean = value.trim().replace(',', '.');
    const [intPart, decPart = ''] = clean.split('.');
    const paddedDec = (decPart + '0'.repeat(scale)).slice(0, scale);
    const sign = clean.startsWith('-') ? -1n : 1n;
    const absInt = BigInt(intPart.replace('-', '') || '0');
    const absDec = scale > 0 ? BigInt(paddedDec) : 0n;

    return new Money(sign * (absInt * scaleFactor + absDec), currency, scale);
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

  multiply(factor: number | bigint): Money {
    if (typeof factor === 'bigint') {
      return new Money(this.amountMinor * factor, this.currency, this.scale);
    }
    const result = Math.round(Number(this.amountMinor) * factor);
    return new Money(BigInt(result), this.currency, this.scale);
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
 */
export class DecimalQuantity {
  readonly rawString: string;
  readonly scale: number;

  constructor(value: string | number, scale: number = 8) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Invalid asset quantity: ${value}`);
      this.rawString = value.toFixed(scale);
    } else {
      const clean = value.trim().replace(',', '.');
      this.rawString = clean;
    }
    this.scale = scale;
  }

  static fromDecimal(value: string | number, scale: number = 8): DecimalQuantity {
    return new DecimalQuantity(value, scale);
  }

  static zero(scale: number = 8): DecimalQuantity {
    return new DecimalQuantity('0', scale);
  }

  toNumber(): number {
    return parseFloat(this.rawString);
  }

  toCanonicalString(): string {
    const num = parseFloat(this.rawString);
    if (isNaN(num)) return '0';
    const fixed = num.toFixed(this.scale);
    return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  }

  isZero(): boolean {
    return this.toNumber() === 0;
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
  source: 'PIERRE' | 'MANUAL';
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
   * Additional bill components (e.g. previous purchase installments,
   * interest/finance charges, IOF, adjustments, credits, refunds).
   * rawBillAmount - purchasesTotal is NOT automatically a reconciliation error!
   */
  additionalComponentsAmount: Money;
  /**
   * Unexplained residual discrepancy after reconciling purchases,
   * installments, charges, and credits.
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
  totalCost: Money;
  averagePrice: Money;
}

export function updateCostBasisOnPurchase(
  current: CostBasisTracker,
  purchaseQuantity: DecimalQuantity,
  unitPrice: Money,
  fees: Money = Money.zero(unitPrice.currency, unitPrice.scale),
): CostBasisTracker {
  const currentQtyNum = current.quantity.toNumber();
  const purchaseQtyNum = purchaseQuantity.toNumber();
  const newQtyNum = currentQtyNum + purchaseQtyNum;

  if (newQtyNum <= 0) {
    return {
      quantity: DecimalQuantity.zero(),
      totalCost: Money.zero(unitPrice.currency, unitPrice.scale),
      averagePrice: Money.zero(unitPrice.currency, unitPrice.scale),
    };
  }

  const scaleFactor = 10n ** BigInt(unitPrice.scale);
  const purchaseCost = Money.fromMinor(
    BigInt(Math.round(purchaseQtyNum * unitPrice.toDecimal() * Number(scaleFactor))) + fees.amountMinor,
    unitPrice.currency,
    unitPrice.scale,
  );
  const newTotalCost = current.totalCost.add(purchaseCost);
  const newAvgPriceDecimal = newTotalCost.toDecimal() / newQtyNum;

  return {
    quantity: DecimalQuantity.fromDecimal(newQtyNum.toString()),
    totalCost: newTotalCost,
    averagePrice: Money.fromDecimal(newAvgPriceDecimal, unitPrice.currency, unitPrice.scale),
  };
}

export function updateCostBasisOnSale(
  current: CostBasisTracker,
  soldQuantity: DecimalQuantity,
): CostBasisTracker {
  const currentQtyNum = current.quantity.toNumber();
  const soldQtyNum = soldQuantity.toNumber();
  const remainingQtyNum = Math.max(0, currentQtyNum - soldQtyNum);

  if (remainingQtyNum <= 0) {
    return {
      quantity: DecimalQuantity.zero(),
      totalCost: Money.zero(current.totalCost.currency, current.totalCost.scale),
      averagePrice: current.averagePrice,
    };
  }

  const remainingCost = Money.fromDecimal(
    remainingQtyNum * current.averagePrice.toDecimal(),
    current.totalCost.currency,
    current.totalCost.scale,
  );
  return {
    quantity: DecimalQuantity.fromDecimal(remainingQtyNum.toString()),
    totalCost: remainingCost,
    averagePrice: current.averagePrice,
  };
}
