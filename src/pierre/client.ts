import {
  PierreAccountsResponse,
  PierreTransactionsResponse,
  PierreBillSummaryResponse,
  PierreInstallmentsResponse,
  PierreManualUpdateResponse,
} from './types';

const DEFAULT_BASE_URL = 'https://api.pierre.com.br';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export interface PierreClientConfig {
  apiKey: string;
  baseUrl?: string;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class PierreClient {
  private apiKey: string;
  private baseUrl: string;
  private logger: PierreClientConfig['logger'];

  constructor(config: PierreClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.logger = config.logger;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Trigger a manual sync on Pierre's side so banks push fresh data.
   */
  async triggerManualUpdate(): Promise<PierreManualUpdateResponse> {
    this.logger?.info('Triggering manual update on Pierre...');
    return this.request<PierreManualUpdateResponse>('/manual-update', 'POST');
  }

  /**
   * Fetch all connected accounts (bank + credit card).
   */
  async getAccounts(): Promise<PierreAccountsResponse> {
    this.logger?.info('Fetching accounts...');
    return this.request<PierreAccountsResponse>('/get-accounts');
  }

  /**
   * Fetch transactions within a date range.
   */
  async getTransactions(startDate?: string, endDate?: string): Promise<PierreTransactionsResponse> {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const qs = params.toString();
    const path = `/get-transactions${qs ? `?${qs}` : ''}`;

    this.logger?.info('Fetching transactions...', { startDate, endDate });
    return this.request<PierreTransactionsResponse>(path);
  }

  /**
   * Fetch the current (open) bill summary for credit cards.
   */
  async getBillSummary(): Promise<PierreBillSummaryResponse> {
    this.logger?.info('Fetching bill summary...');
    return this.request<PierreBillSummaryResponse>('/get-bill-summary');
  }

  /**
   * Fetch installment information for credit card purchases.
   */
  async getInstallments(): Promise<PierreInstallmentsResponse> {
    this.logger?.info('Fetching installments...');
    return this.request<PierreInstallmentsResponse>('/get-installments');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async request<T>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const start = Date.now();
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
        });

        const elapsed = Date.now() - start;
        this.logger?.info(`[${method}] ${path} → ${response.status} (${elapsed}ms)`);

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Pierre API error ${response.status}: ${body}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          this.logger?.warn(
            `Request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`,
            { error: lastError.message },
          );
          await this.sleep(delay);
        }
      }
    }

    this.logger?.error(`Request failed after ${MAX_RETRIES} attempts`, {
      path,
      error: lastError?.message,
    });
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
