import crypto from 'crypto';
import { CompleteMigrationPlan, SchemaPlan, BackfillPlan } from './types';

/**
 * Deterministically serialize any JavaScript value into a canonical JSON string.
 * - Object keys are sorted alphabetically at all nesting levels.
 * - Array order is strictly preserved.
 * - Null, numbers, strings, and booleans are formatted identically.
 * - Undefined properties are omitted.
 */
export function canonicalizeJson(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }

  const sortedKeys = Object.keys(value).sort();
  const pairs: string[] = [];

  for (const key of sortedKeys) {
    const val = value[key];
    if (val !== undefined) {
      pairs.push(`${JSON.stringify(key)}:${canonicalizeJson(val)}`);
    }
  }

  return '{' + pairs.join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 hash of the complete migration plan.
 * Hashing covers the schema plan (DDL steps and payloads) and the backfill plan (DML specs).
 * Timestamps and metadata that vary per execution run are excluded from the hash
 * to ensure that identical plans generate the exact same planHash.
 */
export function computePlanHash(
  plan: { schemaPlan: SchemaPlan; backfillPlan: BackfillPlan } | CompleteMigrationPlan,
): string {
  const contentToHash = {
    schemaPlan: plan.schemaPlan,
    backfillPlan: plan.backfillPlan,
  };

  const canonical = canonicalizeJson(contentToHash);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verifies whether a provided planHash matches the computed hash of the plan.
 */
export function verifyPlanHash(
  plan: CompleteMigrationPlan | { schemaPlan: SchemaPlan; backfillPlan: BackfillPlan },
  expectedHash: string,
): boolean {
  const computed = computePlanHash(plan);
  return computed.toLowerCase() === expectedHash.trim().toLowerCase();
}
