import crypto from 'crypto';
import { Readable } from 'stream';
import { google, drive_v3 } from 'googleapis';
import {
  CheckpointAck,
  CheckpointHeader,
  CheckpointRef,
  CheckpointSink,
  DurableJournalCheckpointer,
  parseCheckpointKey,
  restoreJournalFromDurableHead,
} from './journal-durability';
import { BackfillJournal } from './backfill-journal';

const DRIVE_RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded']);

/**
 * True for Drive's rate-limit rejections (HTTP 429, or 403 with reason userRateLimitExceeded /
 * rateLimitExceeded). Such a request was refused as a whole, so repeating it cannot duplicate anything.
 */
export function isDriveRateLimitError(err: any): boolean {
  const status = Number(err?.status ?? err?.response?.status ?? err?.code);
  if (status === 429) return true;
  if (status !== 403) return false;
  const reasons = [...(err?.errors || []), ...(err?.response?.data?.error?.errors || [])].map((e: any) => e?.reason);
  return reasons.some((r) => DRIVE_RATE_LIMIT_REASONS.has(r));
}

export interface DriveRetryOptions {
  /** Retries after the first attempt, for rate-limit rejections only (default 8). */
  maxRetries?: number;
  /** First backoff delay; doubles per retry, capped at maxDelayMs (defaults 1000 / 64000). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Google Drive checkpoint sink (Drive API v3, OAuth refresh token with the `drive.file` scope, so the
 * app only sees files it created). One immutable file per sequence number; the acknowledgment is the
 * server-computed md5Checksum/size of the stored bytes. Contents are always FIN_JCP_V1 ciphertext.
 * Rate-limit rejections are retried with exponential backoff; any other error surfaces immediately.
 */
export class DriveCheckpointSink implements CheckpointSink {
  constructor(
    private readonly drive: drive_v3.Drive,
    private readonly folderId?: string,
    private readonly retry: DriveRetryOptions = {},
  ) {}

  private async withRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
    const maxRetries = this.retry.maxRetries ?? 8;
    const base = this.retry.baseDelayMs ?? 1000;
    const cap = this.retry.maxDelayMs ?? 64000;
    const sleep = this.retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (!isDriveRateLimitError(err) || attempt >= maxRetries) throw err;
        await sleep(Math.min(base * 2 ** attempt, cap) + Math.floor(Math.random() * base));
      }
    }
  }

  private static fileName(namespace: string, seq: number): string {
    return `fjcp-${namespace}-${String(seq).padStart(8, '0')}.enc`;
  }

  private baseQuery(namespace: string): string {
    const ns = namespace.replace(/'/g, "\\'");
    const parts = [
      'trashed = false',
      `appProperties has { key='fjcp_ns' and value='${ns}' }`,
    ];
    if (this.folderId) parts.push(`'${this.folderId.replace(/'/g, "\\'")}' in parents`);
    return parts.join(' and ');
  }

  async head(namespace: string): Promise<CheckpointRef | null> {
    const res = await this.withRateLimitRetry(() =>
      this.drive.files.list({
        q: this.baseQuery(namespace),
        orderBy: 'name desc',
        pageSize: 1,
        fields: 'files(id,name,md5Checksum,size,appProperties)',
        spaces: 'drive',
      }),
    );
    const f = res.data.files?.[0];
    if (!f) return null;
    return {
      id: f.id!,
      seq: Number(f.appProperties?.fjcp_seq),
      md5: f.md5Checksum || '',
      size: Number(f.size),
    };
  }

  async put(namespace: string, seq: number, blob: Buffer, header: CheckpointHeader): Promise<CheckpointAck> {
    const res = await this.withRateLimitRetry(() =>
      this.drive.files.create({
        requestBody: {
          name: DriveCheckpointSink.fileName(namespace, seq),
          mimeType: 'application/octet-stream',
          parents: this.folderId ? [this.folderId] : undefined,
          appProperties: {
            fjcp_ns: namespace,
            fjcp_seq: String(seq),
            fjcp_digest: header.stateDigest,
          },
        },
        media: { mimeType: 'application/octet-stream', body: Readable.from(blob) },
        fields: 'id,md5Checksum,size,appProperties',
      }),
    );
    return {
      id: res.data.id!,
      seq: Number(res.data.appProperties?.fjcp_seq),
      md5: res.data.md5Checksum || '',
      size: Number(res.data.size),
    };
  }

  async countAtSeq(namespace: string, seq: number): Promise<number> {
    const res = await this.withRateLimitRetry(() =>
      this.drive.files.list({
        q: `${this.baseQuery(namespace)} and appProperties has { key='fjcp_seq' and value='${seq}' }`,
        pageSize: 10,
        fields: 'files(id)',
        spaces: 'drive',
      }),
    );
    return res.data.files?.length ?? 0;
  }

  async get(ref: CheckpointRef): Promise<Buffer> {
    const res = await this.withRateLimitRetry(() =>
      this.drive.files.get({ fileId: ref.id, alt: 'media' }, { responseType: 'arraybuffer' }),
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    if (crypto.createHash('md5').update(buf).digest('hex') !== ref.md5) {
      throw new Error(`FAIL_DURABILITY_CHECKPOINT_CORRUPTED: md5 do download diverge do Drive para seq #${ref.seq}.`);
    }
    return buf;
  }
}

export interface DurabilityEnvConfig {
  sink: CheckpointSink;
  key: Buffer;
  namespace: string;
}

/**
 * Builds the durable sink from the environment. Required (all fail closed if missing):
 * JOURNAL_CHECKPOINT_KEY, JOURNAL_CHECKPOINT_NAMESPACE, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 * JOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN. Optional: JOURNAL_CHECKPOINT_DRIVE_FOLDER_ID.
 */
export function durabilityConfigFromEnv(env: Record<string, string | undefined>): DurabilityEnvConfig {
  const required = [
    'JOURNAL_CHECKPOINT_KEY',
    'JOURNAL_CHECKPOINT_NAMESPACE',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'JOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN',
  ];
  const missing = required.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`FAIL_DURABILITY_NOT_CONFIGURED: Variáveis ausentes: ${missing.join(', ')}.`);
  }
  const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID!.trim(), env.GOOGLE_CLIENT_SECRET!.trim());
  auth.setCredentials({ refresh_token: env.JOURNAL_CHECKPOINT_GOOGLE_REFRESH_TOKEN!.trim() });
  const drive = google.drive({ version: 'v3', auth });
  return {
    sink: new DriveCheckpointSink(drive, env.JOURNAL_CHECKPOINT_DRIVE_FOLDER_ID?.trim() || undefined),
    key: parseCheckpointKey(env.JOURNAL_CHECKPOINT_KEY),
    namespace: env.JOURNAL_CHECKPOINT_NAMESPACE!.trim(),
  };
}

export async function openDurableCheckpointerFromEnv(
  journal: BackfillJournal,
  env: Record<string, string | undefined>,
  opts: { bootstrap?: boolean } = {},
): Promise<DurableJournalCheckpointer> {
  const cfg = durabilityConfigFromEnv(env);
  return DurableJournalCheckpointer.open({ journal, sink: cfg.sink, key: cfg.key, namespace: cfg.namespace, ...opts });
}

export async function restoreJournalFromEnv(
  env: Record<string, string | undefined>,
  targetPath: string,
): Promise<CheckpointHeader> {
  const cfg = durabilityConfigFromEnv(env);
  return restoreJournalFromDurableHead({ sink: cfg.sink, key: cfg.key, namespace: cfg.namespace, targetPath });
}
