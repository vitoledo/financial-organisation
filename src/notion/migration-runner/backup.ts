import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { BackupResult } from './types';

const MAGIC_HEADER = Buffer.from('FIN_ENC_V1'); // 10 bytes
const IV_LENGTH = 12; // 12 bytes for GCM
const TAG_LENGTH = 16; // 16 bytes auth tag

export interface BackupOptions {
  dbPath?: string;
  backupDir?: string;
  key?: string;
  allowInitializeIfMissing?: boolean;
}

export class FinancialBackupManager {
  private dbPath: string;
  private backupDir: string;
  private backupKey?: string;

  constructor(options: BackupOptions = {}) {
    this.dbPath = options.dbPath ?? path.resolve(process.cwd(), 'data', 'financial.db');
    this.backupDir = options.backupDir ?? path.resolve(process.cwd(), 'backups');
    this.backupKey = options.key ?? process.env.MIGRATION_BACKUP_KEY?.trim();
  }

  /**
   * Derive a 32-byte AES-256 key from a passphrase or secret string using SHA-256.
   */
  private deriveKey(key?: string): Buffer {
    const rawKey = key ?? this.backupKey ?? process.env.MIGRATION_BACKUP_KEY?.trim();
    if (!rawKey) {
      throw new Error(
        'Chave de backup não configurada. Defina a variável de ambiente MIGRATION_BACKUP_KEY ou passe --backup-key.',
      );
    }
    return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
  }

  /**
   * Creates an encrypted, immutable, timestamped snapshot of the local financial database.
   * Performs an automated restoration test against a temporary SQLite instance to verify recuperability.
   */
  async createEncryptedBackup(options: { key?: string; allowInitializeIfMissing?: boolean } = {}): Promise<BackupResult> {
    const keyBuffer = this.deriveKey(options.key);

    // If source DB does not exist and allowInitializeIfMissing is requested, initialize minimal DB
    if (!fs.existsSync(this.dbPath)) {
      if (options.allowInitializeIfMissing) {
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

    // Read original SQLite file
    const originalBuffer = fs.readFileSync(this.dbPath);
    const originalSize = originalBuffer.length;

    // Generate random 12-byte IV/nonce
    const iv = crypto.randomBytes(IV_LENGTH);

    // Encrypt with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
    const encryptedChunks = [cipher.update(originalBuffer), cipher.final()];
    const ciphertext = Buffer.concat(encryptedChunks);
    const authTag = cipher.getAuthTag();

    // Construct immutable binary file payload: [MAGIC 10B][IV 12B][TAG 16B][CIPHERTEXT]
    const backupPayload = Buffer.concat([MAGIC_HEADER, iv, authTag, ciphertext]);
    const encryptedSize = backupPayload.length;

    // Filename: financial-backup-YYYYMMDDTHHmmssZ-<nonce>.db.enc
    const timestampIso = new Date().toISOString();
    const timestampClean = timestampIso.replace(/[-:]/g, '').replace(/\..+/, '');
    const uniqueSuffix = crypto.randomBytes(4).toString('hex');
    const backupFileName = `financial-backup-${timestampClean}-${uniqueSuffix}.db.enc`;
    const backupFilePath = path.join(this.backupDir, backupFileName);

    // Write file to disk
    fs.writeFileSync(backupFilePath, backupPayload);

    // Best-effort 0o400 (read-only) for immutability on POSIX filesystems
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(backupFilePath, 0o400);
      } catch {
        /* non-POSIX systems */
      }
    }

    // Compute SHA-256 of the written encrypted file
    const encryptedHashSha256 = crypto.createHash('sha256').update(backupPayload).digest('hex');

    // Perform automated restoration test to prove recoverability
    const verifiedRestoration = await this.testRestoration(backupFilePath, keyBuffer);

    return {
      backupPath: backupFilePath,
      encryptedHashSha256,
      originalSize,
      encryptedSize,
      timestamp: timestampIso,
      verifiedRestoration,
    };
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
      // Clean up temporary database file
      if (fs.existsSync(tempDbPath)) {
        try {
          fs.unlinkSync(tempDbPath);
        } catch {
          /* best effort cleanup */
        }
      }
    }
  }
}
