import { describe, it, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/storage/migrations';
import { Repository } from '../src/storage/repository';
import { buildFinancialSummary, writeFinancialSummary } from '../src/storage/exporter';
import { textOrNull } from '../src/sheets/builders';

describe('exporter', () => {
  let db: Database.Database;
  let repo: Repository;
  const testJsonPath = path.join(__dirname, 'temp-summary.json');

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testJsonPath)) {
      fs.unlinkSync(testJsonPath);
    }
  });

  it('builds financial summary with correct net worth and investment breakdown', () => {
    repo.upsertAccount({
      id: 'acc1',
      name: 'Nubank Conta',
      type: 'BANK',
      subtype: 'CHECKING_ACCOUNT',
      connectorName: 'Nubank',
      closingBalance: 1500,
      creditLimit: null,
      availableCredit: null,
      rawJson: '{}',
    });

    repo.replaceInvestments(
      [
        {
          id: 'inv1',
          asset_name: 'Bitcoin',
          asset_type: 'Cripto',
          origin: 'EXTERNAL',
          pricing_method: 'GOOGLEFINANCE',
          ticker_or_rate: 'CURRENCY:BTCBRL',
          quantity: 0.003,
          cost_basis: 1000,
          start_date: '2026-01-01',
          manual_value: null,
          market_value: 1800,
          market_value_at: '2026-08-02T00:00:00Z',
          pricing_status: 'OK',
          linked_account_id: null,
          notes: 'My BTC',
          source: 'CONFIG_TAB',
        },
        {
          id: 'inv2',
          asset_name: 'Nubank Caixinha',
          asset_type: 'Renda Fixa',
          origin: 'PIERRE',
          pricing_method: 'PIERRE',
          ticker_or_rate: '100% CDI',
          quantity: 1,
          cost_basis: 500,
          start_date: null,
          manual_value: null,
          market_value: 520,
          market_value_at: '2026-08-02T00:00:00Z',
          pricing_status: 'OK',
          linked_account_id: 'acc1',
          notes: 'Pierre automatic',
          source: 'PIERRE_RESERVED',
        },
      ],
      'CONFIG_TAB',
    );

    const summary = buildFinancialSummary(repo);

    expect(summary.accounts).toHaveLength(1);
    expect(summary.investments).toHaveLength(2);
    expect(summary.netWorth.totalAccountsBalance).toBe(1500);
    expect(summary.netWorth.externalInvestmentsMarketValue).toBe(1800);
    expect(summary.netWorth.pierreInvestmentsMarketValue).toBe(520);
    // Net worth = accounts balance + external investments (Pierre investments are already in account balance)
    expect(summary.netWorth.totalNetWorth).toBe(3300);

    writeFinancialSummary(summary, testJsonPath);
    expect(fs.existsSync(testJsonPath)).toBe(true);

    const readBack = JSON.parse(fs.readFileSync(testJsonPath, 'utf8'));
    expect(readBack.netWorth.totalNetWorth).toBe(3300);
  });
});

describe('exporter — pricing honesty', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repo = new Repository(db);
  });

  afterEach(() => db.close());

  const unpriced = {
    id: 'inv-pending',
    asset_name: 'Bitcoin',
    asset_type: 'Cripto',
    origin: 'EXTERNAL',
    pricing_method: 'GOOGLEFINANCE',
    ticker_or_rate: 'CURRENCY:BTCBRL',
    quantity: 0.01,
    cost_basis: 3000,
    start_date: null,
    manual_value: null,
    market_value: null,
    market_value_at: null,
    pricing_status: 'PENDING',
    linked_account_id: null,
    notes: null,
    source: 'CONFIG_TAB',
  };

  test('reports an unpriced holding as null instead of quoting its cost basis', () => {
    repo.replaceInvestments([unpriced], 'CONFIG_TAB');

    const summary = buildFinancialSummary(repo);
    const asset = summary.investments[0];

    expect(asset.marketValue).toBeNull();
    expect(asset.costBasis).toBe(3000);
    expect(asset.pricingStatus).toBe('PENDING');
  });

  test('declares when the aggregate leaned on cost basis', () => {
    repo.replaceInvestments([unpriced], 'CONFIG_TAB');

    const summary = buildFinancialSummary(repo);

    expect(summary.netWorth.usesCostBasisFallback).toBe(true);
    expect(summary.netWorth.unpricedAssets).toEqual(['Bitcoin']);
    // The total still uses cost basis so one bad quote cannot zero the net
    // worth — but the flag above is what makes that honest.
    expect(summary.netWorth.externalInvestmentsMarketValue).toBe(3000);
  });

  test('a fully priced portfolio raises no fallback flag', () => {
    repo.replaceInvestments([{ ...unpriced, market_value: 4200, pricing_status: 'OK' }], 'CONFIG_TAB');

    const summary = buildFinancialSummary(repo);

    expect(summary.netWorth.usesCostBasisFallback).toBe(false);
    expect(summary.netWorth.unpricedAssets).toEqual([]);
    expect(summary.investments[0].marketValue).toBe(4200);
  });

  test('does not stamp a price timestamp on a row that has no price', () => {
    repo.replaceInvestments([unpriced], 'CONFIG_TAB');

    const [stored] = repo.getAllInvestments();
    expect(stored.market_value).toBeNull();
    expect(stored.market_value_at).toBeNull();
  });

  test('defaults an unspecified pricing status to PENDING, never OK', () => {
    const { pricing_status: _ignored, ...withoutStatus } = unpriced;
    repo.replaceInvestments([withoutStatus as never], 'CONFIG_TAB');

    expect(repo.getAllInvestments()[0].pricing_status).toBe('PENDING');
  });
});

describe('Repository.getInvestmentTotals', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repo = new Repository(db);
    repo.replaceInvestments(
      [
        { id: 'e1', asset_name: 'BTC', asset_type: 'Cripto', origin: 'EXTERNAL', pricing_method: 'GOOGLEFINANCE', ticker_or_rate: null, quantity: 1, cost_basis: 100, start_date: null, manual_value: null, market_value: 150, market_value_at: null, pricing_status: 'OK', linked_account_id: null, notes: null, source: 'CONFIG_TAB' },
        { id: 'p1', asset_name: 'Caixinha', asset_type: 'Renda Fixa', origin: 'PIERRE', pricing_method: 'PIERRE', ticker_or_rate: null, quantity: 1, cost_basis: 500, start_date: null, manual_value: null, market_value: 520, market_value_at: null, pricing_status: 'OK', linked_account_id: null, notes: null, source: 'PIERRE_RESERVED' },
      ],
      'CONFIG_TAB',
    );
  });

  afterEach(() => db.close());

  test('separates external from Pierre so net worth cannot double count', () => {
    expect(repo.getInvestmentTotals('EXTERNAL').totalMarket).toBe(150);
    expect(repo.getInvestmentTotals('PIERRE').totalMarket).toBe(520);
    expect(repo.getInvestmentTotals().totalMarket).toBe(670);
  });
});

describe('Repository.replaceInvestments — account links', () => {
  let db: Database.Database;
  let repo: Repository;

  const holding = (linked: string | null) => ({
    id: 'inv1',
    asset_name: 'Bitcoin',
    asset_type: 'Cripto',
    origin: 'EXTERNAL',
    pricing_method: 'GOOGLEFINANCE',
    ticker_or_rate: 'CURRENCY:BTCBRL',
    quantity: 0.01,
    cost_basis: 3000,
    start_date: null,
    manual_value: null,
    market_value: null,
    market_value_at: null,
    pricing_status: 'PENDING',
    linked_account_id: linked,
    notes: null,
    source: 'CONFIG_TAB',
  });

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    repo = new Repository(db);
  });

  afterEach(() => db.close());

  test('drops a link that matches no account instead of aborting the sync', () => {
    // The accounts table is still empty at this point on a first sync, and
    // "Conta Vinculada" is free text the user edits — a literal foreign key
    // would abort the transaction and sink the whole run.
    const result = repo.replaceInvestments([holding('conta-que-nao-existe')], 'CONFIG_TAB');

    expect(result.droppedLinks).toBe(1);
    expect(repo.getAllInvestments()[0].linked_account_id).toBeNull();
  });

  test('keeps a link that resolves to a real account', () => {
    repo.upsertAccount({
      id: 'acc1',
      name: 'Nubank Conta',
      type: 'BANK',
      subtype: 'CHECKING_ACCOUNT',
      connectorName: 'Nubank',
      closingBalance: 100,
      creditLimit: null,
      availableCredit: null,
      automaticallyInvestedBalance: null,
      reservedTotal: null,
      rawJson: '{}',
    });

    const result = repo.replaceInvestments([holding('acc1')], 'CONFIG_TAB');

    expect(result.droppedLinks).toBe(0);
    expect(repo.getAllInvestments()[0].linked_account_id).toBe('acc1');
  });

  test('treats a blank cell as no link at all', () => {
    // Sheets returns "" for an empty cell, and "" is not NULL — as a foreign
    // key it points at an account id of "" and fails the constraint.
    const result = repo.replaceInvestments([holding(textOrNull(''))], 'CONFIG_TAB');

    expect(result.droppedLinks).toBe(0);
    expect(repo.getAllInvestments()[0].linked_account_id).toBeNull();
  });
});
