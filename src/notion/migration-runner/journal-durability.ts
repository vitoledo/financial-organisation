import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { BackfillJournal } from './backfill-journal';
import { BackfillNotionAdapter } from './backfill-adapter';
import { NotionPageRecord, BaseSnapshotData } from './data-snapshot';

/**
 * Durable encrypted journal checkpoint protocol.
 *
 * The live journal lives on an ephemeral filesystem, so the durable copy (the "head" in a remote
 * sink) is AUTHORITATIVE and the local SQLite file is only a working cache. Invariants:
 *
 *  I1. BEFORE every Notion mutation, the journal state containing that mutation's recordAttempt is
 *      checkpointed and the sink has acknowledged it (server-side checksum == local ciphertext).
 *      Enforced structurally by DurabilityGuardedAdapter: a mutation is refused unless the current
 *      journal state digest equals the last acknowledged digest.
 *  I2. AFTER every mutation + read-back, the resulting journal state is checkpointed and acknowledged
 *      before the executor moves on.
 *  I3. Single writer: each checkpoint first verifies the remote head is exactly the last sequence this
 *      process acknowledged, and afterwards that its sequence number is unique. Anything else is
 *      FAIL_DURABILITY_WRITER_CONFLICT.
 *  I4. Checkpoints are AES-256-GCM encrypted; the header (sequence, digests) is authenticated as AAD.
 *      Raw journal bytes never leave the machine.
 *
 * Crash anywhere => restore the durable head. That is always safe: a head taken before a mutation has
 * attempts > 0 for it, which the executor already reconciles by stable identity (uncertain write).
 */

export const CHECKPOINT_MAGIC = Buffer.from('FIN_JCP_V1', 'utf8');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface CheckpointHeader {
  formatVersion: 1;
  namespace: string;
  seq: number;
  prevSeq: number;
  writerId: string;
  reason: string;
  stateDigest: string;
  plaintextSha256: string;
  createdAt: string;
}

export interface CheckpointRef {
  id: string;
  seq: number;
  md5: string;
  size: number;
}

export interface CheckpointAck {
  id: string;
  seq: number;
  md5: string;
  size: number;
}

/**
 * Remote durable storage for encrypted checkpoints. One immutable object per sequence number.
 */
export interface CheckpointSink {
  /** Highest-sequence checkpoint for the namespace, or null when none exists. */
  head(namespace: string): Promise<CheckpointRef | null>;
  /** Stores an immutable checkpoint and returns the server-side acknowledgment (checksum/size). */
  put(namespace: string, seq: number, blob: Buffer, header: CheckpointHeader): Promise<CheckpointAck>;
  /** Number of stored checkpoints carrying this sequence number (must be exactly 1 after put). */
  countAtSeq(namespace: string, seq: number): Promise<number>;
  get(ref: CheckpointRef): Promise<Buffer>;
}

export function parseCheckpointKey(rawKey: string | undefined): Buffer {
  const raw = (rawKey || '').trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else if (raw.length === 44) {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) key = b;
  }
  if (!key) {
    throw new Error(
      'FAIL_DURABILITY_KEY_INVALID: JOURNAL_CHECKPOINT_KEY deve ter 32 bytes (64 hex ou base64 de 44 caracteres).',
    );
  }
  return key;
}

export function encryptCheckpoint(plaintext: Buffer, key: Buffer, header: CheckpointHeader): Buffer {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(headerBuf.length, 0);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([CHECKPOINT_MAGIC, headerLen, headerBuf]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([CHECKPOINT_MAGIC, headerLen, headerBuf, iv, tag, ciphertext]);
}

export function decryptCheckpoint(blob: Buffer, key: Buffer): { header: CheckpointHeader; plaintext: Buffer } {
  const minLen = CHECKPOINT_MAGIC.length + 4 + IV_LENGTH + TAG_LENGTH;
  if (blob.length < minLen || !blob.subarray(0, CHECKPOINT_MAGIC.length).equals(CHECKPOINT_MAGIC)) {
    throw new Error('FAIL_DURABILITY_CHECKPOINT_CORRUPTED: Formato de checkpoint inválido.');
  }
  const headerLen = blob.readUInt32BE(CHECKPOINT_MAGIC.length);
  const headerStart = CHECKPOINT_MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  if (headerEnd + IV_LENGTH + TAG_LENGTH > blob.length) {
    throw new Error('FAIL_DURABILITY_CHECKPOINT_CORRUPTED: Cabeçalho do checkpoint truncado.');
  }
  const iv = blob.subarray(headerEnd, headerEnd + IV_LENGTH);
  const tag = blob.subarray(headerEnd + IV_LENGTH, headerEnd + IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(headerEnd + IV_LENGTH + TAG_LENGTH);

  let plaintext: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(blob.subarray(0, headerEnd));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('FAIL_DURABILITY_CHECKPOINT_CORRUPTED: Autenticação AES-256-GCM falhou (chave errada ou adulteração).');
  }

  const header = JSON.parse(blob.subarray(headerStart, headerEnd).toString('utf8')) as CheckpointHeader;
  const actualSha = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (actualSha !== header.plaintextSha256) {
    throw new Error('FAIL_DURABILITY_CHECKPOINT_CORRUPTED: SHA-256 do journal decifrado diverge do cabeçalho.');
  }
  return { header, plaintext };
}

function md5Hex(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** Opens a decrypted journal image in memory and returns its logical state digest. */
export function digestOfJournalImage(image: Buffer): string {
  const db = new Database(image);
  try {
    const journal = new BackfillJournal(db);
    return journal.stateDigest();
  } finally {
    db.close();
  }
}

export interface DurableCheckpointerOptions {
  journal: BackfillJournal;
  sink: CheckpointSink;
  key: Buffer;
  namespace: string;
  writerId?: string;
  /** Head-visibility retries (eventually consistent listings). */
  maxHeadRetries?: number;
  headRetryDelayMs?: number;
}

export class DurableJournalCheckpointer {
  private lastSeq = 0;
  private lastMd5: string | null = null;
  private lastAckedDigest: string | null = null;
  private readonly writerId: string;

  private constructor(private readonly opts: DurableCheckpointerOptions) {
    this.writerId = opts.writerId || `writer-${crypto.randomUUID()}`;
  }

  /**
   * Binds the local journal to the durable head. The local journal MUST have exactly the head's
   * logical content (restore it first on a fresh machine). With `bootstrap: true` and no remote head,
   * the current local journal becomes checkpoint #1.
   */
  public static async open(
    opts: DurableCheckpointerOptions & { bootstrap?: boolean },
  ): Promise<DurableJournalCheckpointer> {
    const cp = new DurableJournalCheckpointer(opts);
    const head = await opts.sink.head(opts.namespace);
    const localDigest = opts.journal.stateDigest();

    if (!head) {
      if (!opts.bootstrap) {
        throw new Error(
          `FAIL_DURABILITY_NO_HEAD: Nenhum checkpoint durável para '${opts.namespace}'. Execute o bootstrap de durabilidade primeiro.`,
        );
      }
      await cp.checkpoint('BOOTSTRAP');
      return cp;
    }
    if (opts.bootstrap) {
      throw new Error(
        `FAIL_DURABILITY_ALREADY_BOOTSTRAPPED: Namespace '${opts.namespace}' já possui checkpoint #${head.seq}; bootstrap recusado.`,
      );
    }

    const { header } = decryptCheckpoint(await opts.sink.get(head), opts.key);
    if (header.seq !== head.seq || header.namespace !== opts.namespace) {
      throw new Error('FAIL_DURABILITY_CHECKPOINT_CORRUPTED: Metadados do head divergem do cabeçalho autenticado.');
    }
    if (header.stateDigest !== localDigest) {
      throw new Error(
        `FAIL_DURABILITY_HEAD_MISMATCH: Journal local (${localDigest}) diverge do head durável #${head.seq} (${header.stateDigest}). Restaure o head antes de continuar.`,
      );
    }
    cp.lastSeq = head.seq;
    cp.lastMd5 = head.md5;
    cp.lastAckedDigest = header.stateDigest;
    return cp;
  }

  public getLastSeq(): number {
    return this.lastSeq;
  }

  /** True iff the journal's current logical content is exactly the last durably acknowledged one. */
  public isCurrentStateAcked(): boolean {
    return this.lastAckedDigest !== null && this.opts.journal.stateDigest() === this.lastAckedDigest;
  }

  /**
   * Persists the current journal state durably and returns only after the sink acknowledged it.
   * No-op when the current state is already the acknowledged head. Throws on any doubt.
   */
  public async checkpoint(reason: string): Promise<void> {
    const digest = this.opts.journal.stateDigest();
    if (digest === this.lastAckedDigest) return;

    await this.assertHeadIsOurs();

    const plaintext = this.opts.journal.serializeSnapshot();
    const seq = this.lastSeq + 1;
    const header: CheckpointHeader = {
      formatVersion: 1,
      namespace: this.opts.namespace,
      seq,
      prevSeq: this.lastSeq,
      writerId: this.writerId,
      reason,
      stateDigest: digest,
      plaintextSha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      createdAt: new Date().toISOString(),
    };
    const blob = encryptCheckpoint(plaintext, this.opts.key, header);
    const expectedMd5 = md5Hex(blob);

    let ack: CheckpointAck;
    try {
      ack = await this.opts.sink.put(this.opts.namespace, seq, blob, header);
    } catch (err: any) {
      throw new Error(`FAIL_DURABLE_CHECKPOINT_NOT_ACKNOWLEDGED: Checkpoint #${seq} (${reason}) falhou: ${err?.message || err}`);
    }
    if (ack.seq !== seq || ack.md5 !== expectedMd5 || ack.size !== blob.length) {
      throw new Error(
        `FAIL_DURABLE_CHECKPOINT_NOT_ACKNOWLEDGED: Ack do checkpoint #${seq} diverge (md5 ${ack.md5} vs ${expectedMd5}, size ${ack.size} vs ${blob.length}).`,
      );
    }
    // Listings may lag right after an upload: wait for visibility, but never tolerate duplicates.
    let copies = await this.opts.sink.countAtSeq(this.opts.namespace, seq);
    for (let i = 0; copies === 0 && i < (this.opts.maxHeadRetries ?? 5); i++) {
      await new Promise((r) => setTimeout(r, (this.opts.headRetryDelayMs ?? 500) * (i + 1)));
      copies = await this.opts.sink.countAtSeq(this.opts.namespace, seq);
    }
    if (copies !== 1) {
      throw new Error(
        `FAIL_DURABILITY_WRITER_CONFLICT: ${copies} checkpoints com seq #${seq} em '${this.opts.namespace}' (writer concorrente).`,
      );
    }

    this.lastSeq = seq;
    this.lastMd5 = ack.md5;
    this.lastAckedDigest = digest;
  }

  private async assertHeadIsOurs(): Promise<void> {
    const retries = this.opts.maxHeadRetries ?? 5;
    const delay = this.opts.headRetryDelayMs ?? 500;
    let head: CheckpointRef | null = null;
    for (let i = 0; i <= retries; i++) {
      head = await this.opts.sink.head(this.opts.namespace);
      const seq = head?.seq ?? 0;
      if (seq === this.lastSeq && (this.lastSeq === 0 || head?.md5 === this.lastMd5)) return;
      if (seq > this.lastSeq) break; // someone else advanced the head: never wait that out
      if (i < retries) await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
    throw new Error(
      `FAIL_DURABILITY_WRITER_CONFLICT: Head durável (#${head?.seq ?? 0}) não é o último checkpoint deste writer (#${this.lastSeq}).`,
    );
  }
}

/**
 * Replaces the local journal with the durable head (authoritative). The previous local file, if any
 * and different, is kept as `<path>.superseded-<timestamp>` for forensics. Returns the head header.
 */
export async function restoreJournalFromDurableHead(params: {
  sink: CheckpointSink;
  key: Buffer;
  namespace: string;
  targetPath: string;
}): Promise<CheckpointHeader> {
  const head = await params.sink.head(params.namespace);
  if (!head) {
    throw new Error(`FAIL_DURABILITY_NO_HEAD: Nenhum checkpoint durável para '${params.namespace}'.`);
  }
  const { header, plaintext } = decryptCheckpoint(await params.sink.get(head), params.key);
  if (header.seq !== head.seq || header.namespace !== params.namespace) {
    throw new Error('FAIL_DURABILITY_CHECKPOINT_CORRUPTED: Metadados do head divergem do cabeçalho autenticado.');
  }
  if (digestOfJournalImage(plaintext) !== header.stateDigest) {
    throw new Error('FAIL_DURABILITY_CHECKPOINT_CORRUPTED: Digest lógico do journal restaurado diverge do cabeçalho.');
  }

  const target = path.resolve(params.targetPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    let localDigest: string | null = null;
    try {
      localDigest = digestOfJournalImage(fs.readFileSync(target));
    } catch {
      localDigest = null;
    }
    // A local file with a separate -wal must be checkpointed by its owner first; refuse to guess.
    if (fs.existsSync(`${target}-wal`) && fs.statSync(`${target}-wal`).size > 0) {
      throw new Error(`FAIL_DURABILITY_LOCAL_WAL_PRESENT: '${target}-wal' não vazio; feche o writer antes do restore.`);
    }
    if (localDigest === header.stateDigest) return header;
    fs.renameSync(target, `${target}.superseded-${Date.now()}`);
  }
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${target}${suffix}`)) fs.rmSync(`${target}${suffix}`);
  }
  const tmp = `${target}.restore-${process.pid}`;
  fs.writeFileSync(tmp, plaintext, { mode: 0o600 });
  const fd = fs.openSync(tmp, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, target);
  return header;
}

/**
 * Adapter wrapper enforcing invariant I1 structurally: mutations are refused unless the journal's
 * current state has been durably acknowledged. Reads pass through untouched.
 */
export class DurabilityGuardedAdapter implements BackfillNotionAdapter {
  constructor(
    private readonly inner: BackfillNotionAdapter,
    private readonly checkpointer: DurableJournalCheckpointer,
  ) {}

  // Preserve production-adapter markers used by the executor to detect live mode.
  get isProductionMutationAuthorized(): any {
    return (this.inner as any).isProductionMutationAuthorized;
  }
  get totalMutationRequests(): any {
    return (this.inner as any).totalMutationRequests;
  }

  private assertDurable(op: string): void {
    if (!this.checkpointer.isCurrentStateAcked()) {
      throw new Error(
        `FAIL_MUTATION_WITHOUT_DURABLE_CHECKPOINT: ${op} recusado: estado atual do journal não possui checkpoint durável confirmado.`,
      );
    }
  }

  findByStableIdentity(envKey: string, prop: string, value: string): Promise<NotionPageRecord[]> {
    return this.inner.findByStableIdentity(envKey, prop, value);
  }
  fetchPage(pageId: string): Promise<NotionPageRecord | null> {
    return this.inner.fetchPage(pageId);
  }
  queryTargetState(): Promise<Record<string, BaseSnapshotData>> {
    return this.inner.queryTargetState();
  }
  async createPage(envKey: string, dataSourceId: string, properties: Record<string, any>) {
    this.assertDurable('createPage');
    return this.inner.createPage(envKey, dataSourceId, properties);
  }
  async updatePageRelations(envKey: string, pageId: string, relations: Record<string, string[]>) {
    this.assertDurable('updatePageRelations');
    return this.inner.updatePageRelations(envKey, pageId, relations);
  }
  getMutationCount(): number {
    return this.inner.getMutationCount();
  }
}

/** In-memory sink for tests and dry runs. */
export class InMemoryCheckpointSink implements CheckpointSink {
  public readonly objects: { namespace: string; seq: number; blob: Buffer; id: string }[] = [];
  public failNextPut: Error | null = null;
  public corruptNextAck = false;

  async head(namespace: string): Promise<CheckpointRef | null> {
    const own = this.objects.filter((o) => o.namespace === namespace).sort((a, b) => b.seq - a.seq);
    if (own.length === 0) return null;
    const o = own[0];
    return { id: o.id, seq: o.seq, md5: md5Hex(o.blob), size: o.blob.length };
  }
  async put(namespace: string, seq: number, blob: Buffer, _header?: CheckpointHeader): Promise<CheckpointAck> {
    if (this.failNextPut) {
      const e = this.failNextPut;
      this.failNextPut = null;
      throw e;
    }
    const id = `obj-${namespace}-${seq}-${this.objects.length}`;
    this.objects.push({ namespace, seq, blob: Buffer.from(blob), id });
    const md5 = this.corruptNextAck ? '0'.repeat(32) : md5Hex(blob);
    this.corruptNextAck = false;
    return { id, seq, md5, size: blob.length };
  }
  async countAtSeq(namespace: string, seq: number): Promise<number> {
    return this.objects.filter((o) => o.namespace === namespace && o.seq === seq).length;
  }
  async get(ref: CheckpointRef): Promise<Buffer> {
    const o = this.objects.find((x) => x.id === ref.id);
    if (!o) throw new Error('not found');
    return Buffer.from(o.blob);
  }
}
