import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { BackupResult } from './types';

const MAGIC_HEADER = Buffer.from('FIN_ENC_V1'); // 10 bytes
const IV_LENGTH = 12; // 12 bytes for GCM
const TAG_LENGTH = 16; // 16 bytes auth tag
const MIN_KEY_LENGTH = 32;

export interface BackupOptions {
  dbPath?: string;
  backupDir?: string;
  key?: string;
  allowEmptyDbForBackup?: boolean;
}

export class FinancialBackupManager {
  private dbPath: string;
  private backupDir: string;
  private backupKey?: string;
  private allowEmptyDbForBackup: boolean;

  constructor(options: BackupOptions = {}) {
    this.dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'financial.db');
    this.backupDir = options.backupDir ?? path.resolve(process.cwd(), 'backups');
    this.backupKey = options.key ?? process.env.MIGRATION_BACKUP_KEY?.trim();
    // allowEmptyDbForBackup is strictly FALSE by default
    this.allowEmptyDbForBackup = options.allowEmptyDbForBackup ?? false;
  }

  /**
   * Derive a 32-byte AES-256 key from cryptographic material (64-hex, 44-base64, or high-entropy raw secret).
   * Strictly enforces minimum key length (32 chars), entropy, and disallows default/fallback keys.
   */
  private deriveKey(key?: string): Buffer {
    const rawKey = key ?? this.backupKey ?? process.env.MIGRATION_BACKUP_KEY?.trim();
    if (!rawKey) {
      throw new Error(
        'Chave de backup ausente. Configure a variável de ambiente MIGRATION_BACKUP_KEY.',
      );
    }
    if (rawKey.length < MIN_KEY_LENGTH) {
      throw new Error(
        `Chave MIGRATION_BACKUP_KEY fraca. Exigido segredo com no mínimo ${MIN_KEY_LENGTH} caracteres.`,
      );
    }

    // 1. 64-character hex string (32 bytes raw cryptographic key)
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      return Buffer.from(rawKey, 'hex');
    }

    // 2. 44-character base64 string (32 bytes raw cryptographic key)
    if (/^[A-Za-z0-9+/]{42,43}={0,2}$/.test(rawKey) || /^[A-Za-z0-9+/]{44}$/.test(rawKey)) {
      const decoded = Buffer.from(rawKey, 'base64');
      if (decoded.length === 32) {
        return decoded;
      }
    }

    // 3. Raw passphrase: must have high entropy (minimum 8 distinct characters)
    const uniqueChars = new Set(rawKey).size;
    if (uniqueChars < 8) {
      throw new Error(
        'Chave MIGRATION_BACKUP_KEY possui entropia insuficiente (muitos caracteres repetidos).',
      );
    }

    return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
  }

  /**
   * Creates an encrypted, immutable, timestamped snapshot of the local financial database.
   * Produces a consistent SQLite snapshot via the SQLite Backup API before encryption.
   * Performs an automated restoration test against a temporary SQLite instance to verify recuperability.
   * Persists a sidecar manifest file alongside the encrypted snapshot.
   */
  async createEncryptedBackup(options: { key?: string; allowInitializeIfMissing?: boolean } = {}): Promise<BackupResult> {
    const keyBuffer = this.deriveKey(options.key);
    const allowInit = options.allowInitializeIfMissing ?? this.allowEmptyDbForBackup;

    // Fail if source DB is missing (allowEmptyDbForBackup is false by default)
    if (!fs.existsSync(this.dbPath)) {
      if (allowInit) {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const initDb = new Database(this.dbPath);
        initDb.exec('CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY);');
        initDb.close();
      } else {
        throw new Error(`Banco de dados financeiro de origem não encontrado em: ${this.dbPath}`);
      }
    }

    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    // Step 1: Create consistent SQLite snapshot via SQLite Backup API to a temporary file
    const tempSnapshotName = `financial-snapshot-${crypto.randomUUID()}.db`;
    const tempSnapshotPath = path.join(os.tmpdir(), tempSnapshotName);

    try {
      const sourceDb = new Database(this.dbPath, { readonly: true });
      await sourceDb.backup(tempSnapshotPath);
      sourceDb.close();

      // Apply restrictive permissions (0o600) to temporary plaintext snapshot
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(tempSnapshotPath, 0o600);
        } catch {
          /* non-POSIX or permission ignored */
        }
      }

      const snapshotBuffer = fs.readFileSync(tempSnapshotPath);
      const originalSize = snapshotBuffer.length;
      const originalDbSha256 = crypto.createHash('sha256').update(snapshotBuffer).digest('hex');

      // Step 2: Encrypt snapshot with AES-256-GCM
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
      const encryptedChunks = [cipher.update(snapshotBuffer), cipher.final()];
      const ciphertext = Buffer.concat(encryptedChunks);
      const authTag = cipher.getAuthTag();

      // Binary payload: [MAGIC 10B][IV 12B][TAG 16B][CIPHERTEXT]
      const backupPayload = Buffer.concat([MAGIC_HEADER, iv, authTag, ciphertext]);
      const encryptedSize = backupPayload.length;

      // Filename: financial-backup-YYYYMMDDTHHmmssZ-<nonce>.db.enc
      const timestampIso = new Date().toISOString();
      const timestampClean = timestampIso.replace(/[-:]/g, '').replace(/\..+/, '');
      const uniqueSuffix = crypto.randomBytes(4).toString('hex');
      const backupFileName = `financial-backup-${timestampClean}-${uniqueSuffix}.db.enc`;
      const backupFilePath = path.join(this.backupDir, backupFileName);

      // Write encrypted backup to disk with restrictive permissions (0o600)
      fs.writeFileSync(backupFilePath, backupPayload);

      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(backupFilePath, 0o600);
        } catch {
          /* non-POSIX systems */
        }
      }

      // Compute SHA-256 of encrypted file
      const encryptedHashSha256 = crypto.createHash('sha256').update(backupPayload).digest('hex');

      // Step 3: Perform automated restoration test to prove recoverability
      const verifiedRestoration = await this.testRestoration(backupFilePath, keyBuffer);

      // Step 4: Write sidecar manifest file
      const manifestPath = `${backupFilePath}.manifest.json`;
      const localDatabaseScope = 'LOCAL_FINANCIAL_DB_ONLY' as const;
      const notionWorkspaceReconciliationNote =
        'Local SQLite snapshot (financial.db.enc) covers only the local database. Notion workspace state is managed separately via read-before-write live preflight inspection.';

      const manifestContent = {
        format: 'FIN_ENC_V1',
        keyVersion: '1',
        algorithm: 'aes-256-gcm',
        timestamp: timestampIso,
        backupFileName,
        encryptedFileSha256: encryptedHashSha256,
        originalDbSha256,
        originalSizeBytes: originalSize,
        encryptedSizeBytes: encryptedSize,
        verifiedRestoration,
        localDatabaseScope,
        notionWorkspaceReconciliationNote,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');

      return {
        backupPath: backupFilePath,
        manifestPath,
        encryptedHashSha256,
        originalDbSha256,
        originalSize,
        encryptedSize,
        timestamp: timestampIso,
        verifiedRestoration,
        localDatabaseScope,
        notionWorkspaceReconciliationNote,
      };
    } finally {
      // Best-effort plaintext deletion of temporary SQLite snapshot
      if (fs.existsSync(tempSnapshotPath)) {
        try {
          fs.unlinkSync(tempSnapshotPath);
        } catch {
          /* best-effort plaintext deletion */
        }
      }
    }
  }

  /**
   * Decrypts an encrypted backup buffer using AES-256-GCM.
   */
  public decryptBackupBuffer(encryptedBuffer: Buffer, keyBuffer: Buffer): Buffer {
    if (encryptedBuffer.length < MAGIC_HEADER.length + IV_LENGTH + TAG_LENGTH) {
      throw new Error('Arquivo de backup corrompido ou formato inválido: cabeçalho insuficiente.');
    }

    const magic = encryptedBuffer.subarray(0, MAGIC_HEADER.length);
    if (!magic.equals(MAGIC_HEADER)) {
      throw new Error('Formato de backup inválido: cabeçalho mágico não reconhecido.');
    }

    let offset = MAGIC_HEADER.length;
    const iv = encryptedBuffer.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;

    const authTag = encryptedBuffer.subarray(offset, offset + TAG_LENGTH);
    offset += TAG_LENGTH;

    const ciphertext = encryptedBuffer.subarray(offset);

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(authTag);

    const decryptedChunks = [decipher.update(ciphertext), decipher.final()];
    return Buffer.concat(decryptedChunks);
  }

  /**
   * Restores a backup file to a specific destination path.
   */
  async restoreBackup(backupFilePath: string, destinationDbPath: string, key?: string): Promise<void> {
    const keyBuffer = this.deriveKey(key);
    const encryptedBuffer = fs.readFileSync(backupFilePath);
    const decryptedBuffer = this.decryptBackupBuffer(encryptedBuffer, keyBuffer);

    const targetDir = path.dirname(destinationDbPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(destinationDbPath, decryptedBuffer);
  }

  /**
   * Tests decrypting the backup to a temporary SQLite file and running an integrity check.
   */
  private async testRestoration(backupFilePath: string, keyBuffer: Buffer): Promise<boolean> {
    const tempDir = os.tmpdir();
    const tempDbName = `financial-restore-test-${crypto.randomUUID()}.db`;
    const tempDbPath = path.join(tempDir, tempDbName);

    try {
      const encryptedBuffer = fs.readFileSync(backupFilePath);
      const decryptedBuffer = this.decryptBackupBuffer(encryptedBuffer, keyBuffer);

      fs.writeFileSync(tempDbPath, decryptedBuffer);
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(tempDbPath, 0o600);
        } catch {
          /* non-POSIX or permission ignored */
        }
      }

      // Verify SQLite integrity
      const tempDb = new Database(tempDbPath, { readonly: true });
      const checkResult = tempDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      tempDb.close();

      const isOk = Array.isArray(checkResult) && checkResult.length > 0 && checkResult[0].integrity_check === 'ok';

      if (!isOk) {
        throw new Error(`Falha no teste de integridade SQLite do backup restaurado: ${JSON.stringify(checkResult)}`);
      }

      return true;
    } finally {
      if (fs.existsSync(tempDbPath)) {
        try {
          fs.unlinkSync(tempDbPath);
        } catch {
          /* best-effort plaintext deletion */
        }
      }
    }
  }
}
