import { describe, test, expect } from 'vitest';
import {
  normalizeTransaction,
  normalizeAccount,
  shouldExcludeAccount,
  isTransferCategory,
  extractReservedInvestments,
  detectReservePlacement,
  sumReservedBalances,
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

describe('extractReservedInvestments', () => {
  test('extracts reserved balances with rate info', () => {
    const account = makeAccount({
      bankData: {
        closingBalance: 1000,
        transferNumber: '',
        reservedBalances: [
          {
            identification: 'Caixinha Reserva',
            availableAmounts: [
              {
                amount: 500,
                currencyCode: 'BRL',
                remuneration: {
                  indexer: 'CDI',
                  rateType: 'POST_FIXED',
                  calculation: '252',
                  ratePeriodicity: 'ANNUAL',
                  postFixedIndexerPercentage: 102,
                },
              },
            ],
          },
        ],
        hasReservedBalance: true,
        overdraftUsedLimit: 0,
        overdraftContractedLimit: 0,
        unarrangedOverdraftAmount: 0,
        automaticallyInvestedBalance: 0,
      },
    });

    const res = extractReservedInvestments(account);

    expect(res).toHaveLength(1);
    expect(res[0].assetName).toContain('Caixinha Reserva');
    expect(res[0].marketValue).toBe(500);
    expect(res[0].tickerOrRate).toBe('102% CDI');
    expect(res[0].origin).toBe('PIERRE');
  });

  test('falls back to synthetic row if automaticallyInvestedBalance > 0', () => {
    const account = makeAccount({
      bankData: {
        closingBalance: 100,
        transferNumber: '',
        reservedBalances: [],
        hasReservedBalance: true,
        overdraftUsedLimit: 0,
        overdraftContractedLimit: 0,
        unarrangedOverdraftAmount: 0,
        automaticallyInvestedBalance: 9.22,
      },
    });

    const res = extractReservedInvestments(account);

    expect(res).toHaveLength(1);
    expect(res[0].id).toContain('auto');
    expect(res[0].marketValue).toBe(9.22);
    expect(res[0].origin).toBe('PIERRE');
  });
});


// ---------------------------------------------------------------------------
// Reserve placement (D3) — is a caixinha inside closingBalance or beside it?
// ---------------------------------------------------------------------------

function makeBankData(overrides: Partial<PierreAccount['bankData']> = {}) {
  return {
    closingBalance: 1000,
    transferNumber: '',
    reservedBalances: [],
    hasReservedBalance: false,
    overdraftUsedLimit: 0,
    overdraftContractedLimit: 0,
    unarrangedOverdraftAmount: 0,
    automaticallyInvestedBalance: 0,
    ...overrides,
  } as PierreAccount['bankData'];
}

function makeReserve(amount: number, identification = 'Caixinha', currencyCode = 'BRL') {
  return {
    identification,
    availableAmounts: [
      {
        amount,
        currencyCode,
        remuneration: {
          indexer: 'CDI',
          rateType: 'POS_FIXADO',
          calculation: '252',
          ratePeriodicity: 'ANUAL',
          postFixedIndexerPercentage: 102,
        },
      },
    ],
  };
}

describe('detectReservePlacement', () => {
  test('proves the reserve is outside when it exceeds the balance', () => {
    // A part cannot be larger than the whole, so the balance must exclude it.
    expect(detectReservePlacement(500, 900)).toBe('OUTSIDE_BALANCE');
  });

  test('assumes inside when the reserve fits within the balance', () => {
    expect(detectReservePlacement(1000, 400)).toBe('INSIDE_BALANCE');
  });

  test('treats a fully invested balance as inside', () => {
    // The observed Nubank case: closingBalance == automaticallyInvestedBalance.
    // Both models fit, and INSIDE is the conservative default.
    expect(detectReservePlacement(9.22, 9.22)).toBe('INSIDE_BALANCE');
  });

  test('does not trip on cent-level float noise', () => {
    expect(detectReservePlacement(100, 100.005)).toBe('INSIDE_BALANCE');
  });

  test('is inert when there is no reserve at all', () => {
    expect(detectReservePlacement(null, 0)).toBe('INSIDE_BALANCE');
    expect(detectReservePlacement(0, 0)).toBe('INSIDE_BALANCE');
  });
});

describe('sumReservedBalances', () => {
  test('sums itemised reserves in BRL', () => {
    const account = makeAccount({
      bankData: makeBankData({ reservedBalances: [makeReserve(300), makeReserve(200, 'Viagem')] }),
    });

    expect(sumReservedBalances(account)).toBe(500);
  });

  test('ignores non-BRL amounts rather than adding them at face value', () => {
    const account = makeAccount({
      bankData: makeBankData({
        reservedBalances: [
          { identification: 'Multi', availableAmounts: [{ amount: 100, currencyCode: 'USD' }, { amount: 50, currencyCode: 'BRL' }] },
        ],
      }),
    });

    expect(sumReservedBalances(account)).toBe(50);
  });

  test('falls back to the aggregate when no reserve is itemised', () => {
    const account = makeAccount({
      bankData: makeBankData({ reservedBalances: [], automaticallyInvestedBalance: 750 }),
    });

    expect(sumReservedBalances(account)).toBe(750);
  });

  test('is zero for an account with no bankData', () => {
    expect(sumReservedBalances(makeAccount({ bankData: null }))).toBe(0);
  });
});

describe('normalizeAccount — reserve figures', () => {
  test('persists both reserve numbers so the assumption stays auditable', () => {
    const account = makeAccount({
      bankData: makeBankData({ closingBalance: 1000, automaticallyInvestedBalance: 400, reservedBalances: [makeReserve(400)] }),
    });

    const normalized = normalizeAccount(account);

    expect(normalized.automaticallyInvestedBalance).toBe(400);
    expect(normalized.reservedTotal).toBe(400);
  });
});

describe('extractReservedInvestments — placement drives net worth', () => {
  test('a reserve inside the balance is detail only (PIERRE)', () => {
    const account = makeAccount({
      bankData: makeBankData({ closingBalance: 1000, reservedBalances: [makeReserve(400)] }),
    });

    const [reserve] = extractReservedInvestments(account);

    expect(reserve.origin).toBe('PIERRE');
    expect(reserve.notes).toContain('já incluída no saldo');
  });

  test('a reserve larger than the balance counts as standalone value (EXTERNAL)', () => {
    const account = makeAccount({
      bankData: makeBankData({ closingBalance: 100, reservedBalances: [makeReserve(900)] }),
    });

    const [reserve] = extractReservedInvestments(account);

    // Otherwise R$ 900 would be silently dropped from the net worth.
    expect(reserve.origin).toBe('EXTERNAL');
    expect(reserve.notes).toContain('FORA do saldo');
  });

  test('applies the same placement to the aggregate fallback path', () => {
    const account = makeAccount({
      bankData: makeBankData({ closingBalance: 10, reservedBalances: [], automaticallyInvestedBalance: 900 }),
    });

    const [reserve] = extractReservedInvestments(account);

    expect(reserve.origin).toBe('EXTERNAL');
    expect(reserve.marketValue).toBe(900);
  });

  test('carries the indexer percentage through as the rate label', () => {
    const account = makeAccount({
      bankData: makeBankData({ closingBalance: 1000, reservedBalances: [makeReserve(400)] }),
    });

    expect(extractReservedInvestments(account)[0].tickerOrRate).toBe('102% CDI');
  });
});
