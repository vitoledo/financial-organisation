import { describe, test, expect } from 'vitest';
import {
  normalizeTransaction,
  normalizeAccount,
  shouldExcludeAccount,
  isTransferCategory,
} from '../src/pierre/normalizer';
import { PierreAccount, PierreTransaction } from '../src/pierre/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTx(overrides: Partial<PierreTransaction> = {}): PierreTransaction {
  return {
    id: 'tx-1',
    account_id: 'acc-1',
    description: 'Compra teste',
    category: 'Compras',
    original_category: 'Compras',
    tr_confidence: null,
    tr_reasoning: null,
    currency_code: 'BRL',
    amount: -10,
    amount_in_account_currency: null,
    date: '2026-06-15T12:00:00.000Z',
    installment_due_date: null,
    type: 'DEBIT',
    status: 'POSTED',
    payment_data: null,
    credit_card_data: null,
    merchant: null,
    account_name: 'Nubank',
    account_type: 'BANK',
    account_subtype: 'CHECKING_ACCOUNT',
    account_item_id: 'item-1',
    connector_name: 'Nubank',
    connector_image_url: '',
    ...overrides,
  };
}

function makeAccount(overrides: Partial<PierreAccount> = {}): PierreAccount {
  return {
    id: 'acc-1',
    itemId: 'item-1',
    name: 'Nu Pagamentos S.A.',
    type: 'BANK',
    subtype: 'CHECKING_ACCOUNT',
    number: '123',
    currencyCode: 'BRL',
    balance: '9.22',
    creditData: null,
    bankData: null,
    marketingName: null,
    taxNumber: null,
    owner: 'Owner',
    customName: null,
    userId: 'user-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    connectorName: 'Nubank',
    connectorImageUrl: null,
    itemLastUpdatedAt: null,
    itemIsActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeTransaction — direction and sign rules
// ---------------------------------------------------------------------------

describe('normalizeTransaction', () => {
  test('inverts sign of credit card purchase (positive → negative EXPENSE)', () => {
    const tx = makeTx({ account_type: 'CREDIT', amount: 50 });

    const result = normalizeTransaction(tx);

    expect(result.amount).toBe(-50);
    expect(result.direction).toBe('EXPENSE');
    expect(result.originalAmount).toBe(50);
  });

  test('inverts sign of credit card refund (negative → positive INCOME)', () => {
    const tx = makeTx({ account_type: 'CREDIT', amount: -30 });

    const result = normalizeTransaction(tx);

    expect(result.amount).toBe(30);
    expect(result.direction).toBe('INCOME');
    expect(result.originalAmount).toBe(-30);
  });

  test('keeps bank account expense sign (negative → EXPENSE)', () => {
    const tx = makeTx({ account_type: 'BANK', amount: -75.7 });

    const result = normalizeTransaction(tx);

    expect(result.amount).toBe(-75.7);
    expect(result.direction).toBe('EXPENSE');
  });

  test('keeps bank account income sign (positive → INCOME)', () => {
    const tx = makeTx({ account_type: 'BANK', amount: 1000 });

    const result = normalizeTransaction(tx);

    expect(result.amount).toBe(1000);
    expect(result.direction).toBe('INCOME');
  });

  test.each([
    'Pagamento de cartão de crédito',
    'Transferências',
    'Transferência',
    'Resgate',
    'Aplicação',
  ])('classifies "%s" as TRANSFER with sign untouched', (category) => {
    const bankTx = makeTx({ account_type: 'BANK', amount: -102.95, category });
    const creditTx = makeTx({ account_type: 'CREDIT', amount: -15, category });

    expect(normalizeTransaction(bankTx).direction).toBe('TRANSFER');
    expect(normalizeTransaction(bankTx).amount).toBe(-102.95);
    expect(normalizeTransaction(creditTx).direction).toBe('TRANSFER');
    expect(normalizeTransaction(creditTx).amount).toBe(-15);
  });

  test('maps identity fields and serializes rawJson', () => {
    const tx = makeTx({ id: 'abc', account_id: 'acc-9', status: 'PENDING' });

    const result = normalizeTransaction(tx);

    expect(result.id).toBe('abc');
    expect(result.accountId).toBe('acc-9');
    expect(result.status).toBe('PENDING');
    expect(JSON.parse(result.rawJson).id).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// isTransferCategory
// ---------------------------------------------------------------------------

describe('isTransferCategory', () => {
  test('returns true for transfer categories and false otherwise', () => {
    expect(isTransferCategory('Transferências')).toBe(true);
    expect(isTransferCategory('Compras')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldExcludeAccount
// ---------------------------------------------------------------------------

describe('shouldExcludeAccount', () => {
  test('excludes wallet accounts by name', () => {
    expect(shouldExcludeAccount(makeAccount({ name: 'Carteira' }))).toBe(true);
  });

  test('excludes wallet accounts by customName', () => {
    const account = makeAccount({ name: 'Outro', customName: 'Carteira Pierre' });
    expect(shouldExcludeAccount(account)).toBe(true);
  });

  test('keeps regular accounts', () => {
    expect(shouldExcludeAccount(makeAccount())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeAccount
// ---------------------------------------------------------------------------

describe('normalizeAccount', () => {
  test('composes friendly name from connector for credit cards', () => {
    const account = makeAccount({
      type: 'CREDIT',
      subtype: 'CREDIT_CARD',
      connectorName: 'Nubank',
    });

    expect(normalizeAccount(account).name).toBe('Nubank Cartão');
  });

  test('composes friendly name from connector for bank accounts', () => {
    const account = makeAccount({ subtype: 'CHECKING_ACCOUNT', connectorName: 'Nubank' });

    expect(normalizeAccount(account).name).toBe('Nubank Conta');
  });

  test('falls back to raw account name without connector', () => {
    const account = makeAccount({ connectorName: null, name: 'Minha Conta' });

    expect(normalizeAccount(account).name).toBe('Minha Conta');
  });

  test('extracts closingBalance from bankData and nulls without creditData', () => {
    const account = makeAccount({
      bankData: {
        closingBalance: 9.22,
        transferNumber: '',
        reservedBalances: [],
        hasReservedBalance: false,
        overdraftUsedLimit: 0,
        overdraftContractedLimit: 0,
        unarrangedOverdraftAmount: 0,
        automaticallyInvestedBalance: 9.22,
      },
    });

    const result = normalizeAccount(account);

    expect(result.closingBalance).toBe(9.22);
    expect(result.creditLimit).toBeNull();
    expect(result.availableCredit).toBeNull();
  });

  test('extracts credit limits from creditData', () => {
    const account = makeAccount({
      type: 'CREDIT',
      subtype: 'CREDIT_CARD',
      creditData: {
        brand: 'MASTERCARD',
        level: 'GOLD',
        status: 'ACTIVE',
        holderType: null,
        creditLimit: 1550,
        balanceDueDate: '2026-06-22',
        minimumPayment: 0,
        additionalCards: [],
        isLimitFlexible: false,
        balanceCloseDate: null,
        brandAdditionalInfo: '',
        availableCreditLimit: 200,
        balanceForeignCurrency: null,
        disaggregatedCreditLimits: [],
      },
    });

    const result = normalizeAccount(account);

    expect(result.creditLimit).toBe(1550);
    expect(result.availableCredit).toBe(200);
    expect(result.closingBalance).toBeNull();
  });
});
