/**
 * Shared types for the incremental Pierre → SQLite → Notion sync.
 *
 * The sync is a deterministic projection: every run derives the desired Notion state for the fields the
 * pipeline owns (UPSTREAM / DERIVADO authority in TARGET_CONTRACT) from the full SQLite history, diffs it
 * against the live pages and applies the minimal set of creates/patches. Fields owned by the user
 * (USUARIO, or absent from the contract) are never written, and classification fields
 * (REGRA_AUTOMATICA) are only written on create or while a record is still untouched and pending review.
 */

/** Row of the local `transactions` table, as the backfill planner read it. */
export interface SqliteTransactionRow {
  id: string;
  account_id: string;
  date: string;
  description: string;
  amount: number;
  direction: string;
  category_pierre: string | null;
  category_mapped: string | null;
  account_type: string;
  status: string | null;
  raw_json: string | null;
}

/** Row of the local `accounts` table. */
export interface SqliteAccountRow {
  id: string;
  name: string;
  type: string;
  subtype: string;
  closing_balance: number | null;
  credit_limit: number | null;
  available_credit: number | null;
  last_synced_at: string | null;
  /** Full Pierre account payload (card balance = current open bill, customized limit). */
  raw_json?: string | null;
}

/** An official bill from Pierre's GET /get-bills, as kept in the local `card_bills` table. */
export interface OfficialBill {
  id: string;
  accountId: string;
  /** YYYY-MM-DD */
  dueDate: string | null;
  closingDate: string | null;
  /** Statement balance at closing (negative = credit). */
  totalAmount: number | null;
}

export type AccountRole = 'CHECKING' | 'CREDIT';

export interface NotionAccountRef {
  id: string;
  name: string;
  /** Pierre account id stored in the Notion page ("ID da fonte"), when present. */
  sourceId?: string | null;
}

export interface ProjectionContext {
  /** Pierre account id → role, from the account mapping file (same file the backfill used). */
  accountRoles: Record<string, AccountRole>;
  defaultDueDay?: number;
  notionAccounts: NotionAccountRef[];
  /** lower-cased category name → Notion page id (Categorias Financeiras). */
  categoryIdByName: Map<string, string>;
  hmacKey?: string;
  hmacKeyVersion: string;
  sameOwnershipKeywords: string[];
  checkingAccountName: string;
  creditAccountName: string;
  /**
   * Official bills of the card. When at least one carries a closing date, cycles are anchored on the bank's
   * own closing/due dates instead of being inferred from purchase dates.
   */
  officialBills?: OfficialBill[];
  /** Today in America/Sao_Paulo (YYYY-MM-DD); drives the bill status. Kept out of the projection's clock. */
  today?: string;
}

export type ClassificationBranch =
  | 'THIRD_PARTY_INCOMING'
  | 'SAME_OWNERSHIP_INCOMING'
  | 'CARD_BILL_PAYMENT'
  | 'SAME_OWNERSHIP_OUTGOING'
  | 'THIRD_PARTY_OUTGOING'
  | 'STANDARD_EXPENSE'
  | 'UNRESOLVED_CATEGORY';

/** Desired state of one transaction page. `payload` uses the physical Notion property names. */
export interface ProjectedTransaction {
  stableId: string;
  payload: Record<string, any>;
  /** Relations to pages that already exist (Conta, Categoria). */
  relations: Record<string, string[]>;
  /** Stable id of the card bill this purchase belongs to (Fatura Vinculada), if any. */
  billStableId: string | null;
  branch: ClassificationBranch;
  counterpartyName: string;
  accountPageId: string | null;
}

/** Desired state of one card bill page. */
export interface ProjectedBill {
  stableId: string;
  payload: Record<string, any>;
  cardPageId: string;
  /** Stable ids (transaction source ids) of the purchases of the cycle ("Lançamentos do Ciclo"). */
  purchaseIds: string[];
  /** Stable ids of the payment transactions allocated to the cycle ("Transações de Pagamento"). */
  paymentIds: string[];
}

export interface ProjectionResult {
  transactions: ProjectedTransaction[];
  bills: ProjectedBill[];
  unresolvedAccountIds: string[];
}

/** A classification rule from "Regras de Classificação" (user-owned), parsed from the live page. */
export interface ClassificationRule {
  pageId: string;
  name: string;
  priority: number;
  active: boolean;
  autoApply: boolean;
  requireReview: boolean;
  counterpartyContains: string | null;
  descriptionContains: string | null;
  pierreCategory: string | null;
  sourceAccountPageId: string | null;
  expectedMovement: 'Entrada' | 'Saída' | 'Qualquer' | null;
  exactValue: number | null;
  tolerance: number | null;
  minValue: number | null;
  maxValue: number | null;
  minDay: number | null;
  maxDay: number | null;
  validFrom: string | null;
  validUntil: string | null;
  resultNature: string | null;
  resultEffect: string | null;
  resultAllocation: string | null;
  resultCategoryPageId: string | null;
  resultDestinationAccountPageId: string | null;
}

/** A live Notion page reduced to what the sync needs. */
export interface LivePage {
  pageId: string;
  /** Canonical values (TARGET_CONTRACT canonicalization) keyed by contract property name. */
  canonical: Record<string, any>;
  /** Raw Notion properties (for user-owned fields such as "Revisado"). */
  raw: Record<string, any>;
}
