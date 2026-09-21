import crypto from 'crypto';
import { TARGET_CONTRACT, PropertyContract } from '../../domain/schema-contract';

export const SUPPORTED_CURRENCIES = ['BRL', 'USD', 'EUR'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Converts monetary amount to integer minor units (e.g. cents).
 * Enforces round-trip verification to ensure no precision loss.
 * Throws FAIL_UNSUPPORTED_MONEY_PRECISION if precision exceeds 2 decimal places.
 */
export function moneyToMinorUnits(amount: number | string, currency: string = 'BRL'): number {
  const curr = currency.toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(curr as SupportedCurrency)) {
    throw new Error(`FAIL_UNSUPPORTED_CURRENCY: Moeda '${currency}' não suportada para conversão.`);
  }

  let num: number;
  if (typeof amount === 'string') {
    num = parseFloat(amount.replace(',', '.'));
  } else {
    num = amount;
  }

  if (!Number.isFinite(num)) {
    throw new Error('FAIL_UNSUPPORTED_MONEY_PRECISION: Valor monetário não é número finito.');
  }

  const minor = Math.round(num * 100);
  const roundTrip = minor / 100;

  // Enforce round-trip precision check
  if (Math.abs(roundTrip - num) > 1e-4) {
    throw new Error(
      `FAIL_UNSUPPORTED_MONEY_PRECISION: Valor '${amount}' possui precisão incompatível com centavos (minor units). Roundtrip=${roundTrip}, Original=${num}`,
    );
  }

  return minor;
}

/**
 * Converts integer minor units back to floating point number.
 */
export function minorUnitsToMoney(minor: number, currency: string = 'BRL'): number {
  if (!Number.isInteger(minor)) {
    throw new Error(`FAIL_UNSUPPORTED_MONEY_PRECISION: Minor units deve ser inteiro, recebido '${minor}'.`);
  }
  return minor / 100;
}

/**
 * Resolves a property definition in TARGET_CONTRACT by canonical name or alias.
 */
export function findPropertyContract(
  envKey: string,
  propertyName: string,
): PropertyContract | undefined {
  const dsContract = TARGET_CONTRACT[envKey];
  if (!dsContract) {
    throw new Error(`FAIL_UNKNOWN_DATA_SOURCE: Data source '${envKey}' não existe no TARGET_CONTRACT.`);
  }

  return dsContract.properties.find(
    (p) =>
      p.notionProperty === propertyName ||
      (p.aliases && p.aliases.includes(propertyName)) ||
      p.domainField === propertyName,
  );
}

export interface StableIdentitySpec {
  domainField: string;
  physicalProperty: string;
  canonicalProperty: string;
  stableIdValue: string;
}

/**
 * Resolves the deterministic stable identity specification for a given operation.
 * For Transactions: domainField='sourceTransactionId', physicalProperty='ID da fonte'
 * For Card Bills: domainField='stableBillId', physicalProperty='ID Estável da Fatura'
 */
export function resolveStableIdentitySpec(
  operation: {
    targetDataSource: { envKey: string } | string;
    sanitizedPayload?: Record<string, any>;
    stableId?: string;
  },
): StableIdentitySpec {
  const envKey =
    typeof operation.targetDataSource === 'string'
      ? operation.targetDataSource
      : operation.targetDataSource.envKey;

  const dsContract = TARGET_CONTRACT[envKey];
  if (!dsContract) {
    throw new Error(`FAIL_UNKNOWN_DATA_SOURCE: Data source '${envKey}' não existe no TARGET_CONTRACT.`);
  }

  let domainField = '';
  if (envKey === 'NOTION_DS_TRANSACTIONS') {
    domainField = 'sourceTransactionId';
  } else if (envKey === 'NOTION_DS_CARD_BILLS') {
    domainField = 'stableBillId';
  } else {
    domainField = 'sourceTransactionId';
  }

  const propContract = dsContract.properties.find((p) => p.domainField === domainField);
  if (!propContract) {
    throw new Error(
      `FAIL_CONTRACT_NOT_FOUND: Propriedade com domainField '${domainField}' não encontrada em '${envKey}'.`,
    );
  }

  // Find physical property key in sanitizedPayload if present
  let physicalProperty = propContract.notionProperty;
  if (operation.sanitizedPayload) {
    for (const key of Object.keys(operation.sanitizedPayload)) {
      const match = findPropertyContract(envKey, key);
      if (match && match.domainField === domainField) {
        physicalProperty = key;
        break;
      }
    }
  } else {
    // If no sanitizedPayload, check explicit aliases known to be physical live names
    if (envKey === 'NOTION_DS_TRANSACTIONS' && propContract.aliases?.includes('ID da fonte')) {
      physicalProperty = 'ID da fonte';
    }
  }

  const stableIdValue =
    operation.stableId || (operation.sanitizedPayload ? String(operation.sanitizedPayload[physicalProperty] ?? '') : '');

  return {
    domainField,
    physicalProperty,
    canonicalProperty: propContract.notionProperty,
    stableIdValue,
  };
}

/**
 * Canonicalizes a single property value for deterministic comparison and fingerprinting.
 */
export function canonicalizePropertyValue(
  contract: PropertyContract,
  value: any,
): any {
  if (value === null || value === undefined) {
    return null;
  }

  switch (contract.notionType) {
    case 'number': {
      if (typeof value !== 'number' && typeof value !== 'string') {
        throw new Error(
          `FAIL_TYPE_MISMATCH: Propriedade '${contract.notionProperty}' esperava número, recebido ${typeof value}`,
        );
      }
      const numVal = typeof value === 'string' ? parseFloat(value) : value;
      if (!Number.isFinite(numVal)) {
        throw new Error(`FAIL_TYPE_MISMATCH: Propriedade '${contract.notionProperty}' valor numérico inválido.`);
      }
      if (contract.numberFormat === 'real') {
        // Enforce integer minor units representation for fingerprinting
        return moneyToMinorUnits(numVal);
      }
      return Math.round(numVal * 10000) / 10000;
    }

    case 'title':
    case 'rich_text': {
      if (typeof value === 'string') {
        return value.trim();
      }
      if (Array.isArray(value)) {
        return value
          .map((item: any) => item?.plain_text || item?.text?.content || '')
          .join('')
          .trim();
      }
      return String(value).trim();
    }

    case 'select': {
      let strVal = '';
      if (typeof value === 'string') {
        strVal = value.trim();
      } else if (value && typeof value === 'object' && value.name) {
        strVal = String(value.name).trim();
      } else {
        throw new Error(
          `FAIL_TYPE_MISMATCH: Propriedade '${contract.notionProperty}' esperava select name, recebido ${JSON.stringify(value)}`,
        );
      }

      // Check allowed options
      if (contract.expectedOptions && contract.expectedOptions.length > 0) {
        const matchesOption =
          contract.expectedOptions.includes(strVal) ||
          (contract.optionMappings && (contract.optionMappings[strVal] || Object.values(contract.optionMappings).includes(strVal)));
        if (!matchesOption && !contract.allowExtraOptions) {
          throw new Error(
            `FAIL_UNKNOWN_SELECT_OPTION: Opção '${strVal}' inválida para propriedade '${contract.notionProperty}'. Permitidas: ${contract.expectedOptions.join(', ')}`,
          );
        }
      }
      return strVal;
    }

    case 'multi_select': {
      let items: string[] = [];
      if (Array.isArray(value)) {
        items = value.map((i: any) => (typeof i === 'string' ? i.trim() : (i?.name ? String(i.name).trim() : '')));
      } else if (typeof value === 'string') {
        items = [value.trim()];
      }
      return items.filter(Boolean).sort();
    }

    case 'date': {
      if (typeof value === 'string') {
        return { start: value.trim(), end: null };
      }
      if (value && typeof value === 'object' && value.start) {
        return {
          start: String(value.start).trim(),
          end: value.end ? String(value.end).trim() : null,
        };
      }
      throw new Error(
        `FAIL_TYPE_MISMATCH: Propriedade '${contract.notionProperty}' esperava data ISO, recebido ${JSON.stringify(value)}`,
      );
    }

    case 'relation': {
      if (Array.isArray(value)) {
        return value
          .map((item: any) => (typeof item === 'string' ? item.trim() : item?.id ? String(item.id).trim() : ''))
          .filter(Boolean)
          .sort();
      }
      if (typeof value === 'string') {
        return [value.trim()];
      }
      return [];
    }

    case 'checkbox': {
      return Boolean(value);
    }

    default:
      return value;
  }
}

/**
 * Validates and serializes a property dictionary into Notion API create/update format.
 * Strictly adheres to TARGET_CONTRACT:
 * - Rejects unknown properties (FAIL_UNKNOWN_PROPERTY)
 * - Validates types and select options
 * - Omits null/undefined unknown fields without inventing defaults (0, "", etc.)
 * - Validates title presence on create
 */
export function serializePayloadForNotion(
  envKey: string,
  payload: Record<string, any>,
  relations: Record<string, string[]> = {},
  isCreate: boolean = true,
): {
  notionProperties: Record<string, any>;
  canonicalProperties: Record<string, any>;
} {
  const dsContract = TARGET_CONTRACT[envKey];
  if (!dsContract) {
    throw new Error(`FAIL_UNKNOWN_DATA_SOURCE: Data source '${envKey}' não existe no TARGET_CONTRACT.`);
  }

  const notionProperties: Record<string, any> = {};
  const canonicalProperties: Record<string, any> = {};

  // 1. Process scalar properties in payload
  for (const [key, value] of Object.entries(payload)) {
    const contract = findPropertyContract(envKey, key);
    if (!contract) {
      throw new Error(
        `FAIL_UNKNOWN_PROPERTY: Propriedade '${key}' não existe no TARGET_CONTRACT para '${envKey}'.`,
      );
    }

    const isCanonical = key === contract.notionProperty;
    const isExplicitAlias = Boolean(contract.aliases && contract.aliases.includes(key));
    if (!isCanonical && !isExplicitAlias) {
      throw new Error(
        `FAIL_UNKNOWN_PROPERTY: Propriedade '${key}' não é canônica nem alias explícito do contrato '${contract.notionProperty}'.`,
      );
    }

    // null means unknown -> omit on create, do not convert to 0 or ""
    if (value === null || value === undefined) {
      continue;
    }

    const canonicalVal = canonicalizePropertyValue(contract, value);
    canonicalProperties[contract.notionProperty] = canonicalVal;

    // Format for Notion API preserving physical property key
    switch (contract.notionType) {
      case 'title':
        if ((!canonicalVal || String(canonicalVal).trim().length === 0) && isCreate) {
          throw new Error(`FAIL_MISSING_TITLE: Propriedade de título '${key}' não pode ser vazia.`);
        }
        notionProperties[key] = {
          title: [{ text: { content: String(canonicalVal) } }],
        };
        break;

      case 'rich_text':
        notionProperties[key] = {
          rich_text: canonicalVal ? [{ text: { content: String(canonicalVal) } }] : [],
        };
        break;

      case 'number': {
        const floatVal = contract.numberFormat === 'real' ? minorUnitsToMoney(canonicalVal) : canonicalVal;
        notionProperties[key] = {
          number: floatVal,
        };
        break;
      }

      case 'select':
        notionProperties[key] = {
          select: { name: canonicalVal },
        };
        break;

      case 'multi_select':
        notionProperties[key] = {
          multi_select: (canonicalVal as string[]).map((name) => ({ name })),
        };
        break;

      case 'date':
        notionProperties[key] = {
          date: canonicalVal,
        };
        break;

      case 'checkbox':
        notionProperties[key] = {
          checkbox: canonicalVal,
        };
        break;

      case 'relation':
        notionProperties[key] = {
          relation: (canonicalVal as string[]).map((id) => ({ id })),
        };
        break;

      default:
        break;
    }
  }

  // 2. Process relations if provided
  for (const [relKey, targetPageIds] of Object.entries(relations)) {
    const contract = findPropertyContract(envKey, relKey);
    if (!contract) {
      throw new Error(
        `FAIL_UNKNOWN_PROPERTY: Propriedade relacional '${relKey}' não existe no TARGET_CONTRACT para '${envKey}'.`,
      );
    }
    const isCanonical = relKey === contract.notionProperty;
    const isExplicitAlias = Boolean(contract.aliases && contract.aliases.includes(relKey));
    if (!isCanonical && !isExplicitAlias) {
      throw new Error(
        `FAIL_UNKNOWN_PROPERTY: Propriedade relacional '${relKey}' não é canônica nem alias explícito do contrato '${contract.notionProperty}'.`,
      );
    }
    if (contract.notionType !== 'relation') {
      throw new Error(
        `FAIL_TYPE_MISMATCH: Propriedade '${relKey}' no TARGET_CONTRACT não é do tipo relation.`,
      );
    }

    const sortedIds = [...targetPageIds].sort();
    canonicalProperties[contract.notionProperty] = sortedIds;
    notionProperties[relKey] = {
      relation: sortedIds.map((id) => ({ id })),
    };
  }

  // 3. Verify title requirement semantically on create
  if (isCreate) {
    let hasValidTitle = false;
    for (const key of Object.keys(notionProperties)) {
      const contract = findPropertyContract(envKey, key);
      if (contract && contract.notionType === 'title') {
        const titleItems = notionProperties[key]?.title;
        if (Array.isArray(titleItems) && titleItems.length > 0 && titleItems[0]?.text?.content) {
          hasValidTitle = true;
          break;
        }
      }
    }
    if (!hasValidTitle) {
      const titleProp = dsContract.properties.find((p) => p.notionType === 'title');
      throw new Error(
        `FAIL_MISSING_TITLE: Propriedade obrigatória de título '${titleProp?.notionProperty || 'title'}' ausente na criação em '${envKey}'.`,
      );
    }
  }

  return {
    notionProperties,
    canonicalProperties,
  };
}

/**
 * Normalizes canonical properties for deterministic fingerprinting:
 * Rule:
 * - relation: [] (empty array) -> omitted from fingerprint (matches absent relation)
 * - relation: [id, ...] (non-empty array) -> ALWAYS material and kept
 * - number 0, checkbox false, rich_text "", select, date -> NEVER omitted, remain material
 */
export function normalizeCanonicalPropertiesForFingerprint(
  envKey: string,
  canonicalProperties: Record<string, any>,
): Record<string, any> {
  const dsContract = TARGET_CONTRACT[envKey];
  const normalized: Record<string, any> = {};

  for (const [key, value] of Object.entries(canonicalProperties)) {
    if (value === null || value === undefined) {
      continue;
    }
    const contract = dsContract?.properties.find(
      (p) => p.notionProperty === key || (p.aliases && p.aliases.includes(key)) || p.domainField === key,
    );
    // If it is a relation and empty array -> omit from fingerprint
    if (contract && contract.notionType === 'relation' && Array.isArray(value) && value.length === 0) {
      continue;
    }
    normalized[contract ? contract.notionProperty : key] = value;
  }

  return normalized;
}

/**
 * Computes a deterministic SHA-256 fingerprint of canonical properties.
 * Empty relations ([]) are normalized symmetrically to absent relations.
 */
export function calculatePropertiesFingerprint(
  envKey: string,
  canonicalProperties: Record<string, any>,
): string {
  const normalized = normalizeCanonicalPropertiesForFingerprint(envKey, canonicalProperties);
  const sortedKeys = Object.keys(normalized).sort();
  const sortedObj: Record<string, any> = {};
  for (const k of sortedKeys) {
    const val = normalized[k];
    if (val !== null && val !== undefined) {
      sortedObj[k] = val;
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify(sortedObj)).digest('hex');
}

/**
 * Extracts and canonicalizes properties from an existing Notion page record.
 * Empty relation properties ([]) are omitted so they do not produce unexpected extra properties.
 */
export function canonicalizePageRecord(
  envKey: string,
  recordProperties: Record<string, any>,
): Record<string, any> {
  const dsContract = TARGET_CONTRACT[envKey];
  if (!dsContract) {
    throw new Error(`FAIL_UNKNOWN_DATA_SOURCE: Data source '${envKey}' não existe no TARGET_CONTRACT.`);
  }

  const canonical: Record<string, any> = {};
  const recordKeys = Object.keys(recordProperties);

  for (const contract of dsContract.properties) {
    const propName = contract.notionProperty;
    const allowedKeys = [propName, ...(contract.aliases || [])];

    // Find all matching keys in recordProperties that are present (not undefined)
    const matches = recordKeys.filter(
      (k) => allowedKeys.includes(k) && recordProperties[k] !== undefined,
    );

    if (matches.length === 0) {
      continue;
    }

    if (matches.length > 1) {
      throw new Error(
        `FAIL_AMBIGUOUS_RUNTIME_PROPERTY: Múltiplas propriedades conflitantes para '${contract.notionProperty}' em '${envKey}': [${matches.join(', ')}].`,
      );
    }

    const matchedKey = matches[0];
    const rawValue = recordProperties[matchedKey];

    let parsedVal: any = null;

    if (rawValue !== null) {
      if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        if ('title' in rawValue && Array.isArray(rawValue.title)) {
          parsedVal = rawValue.title.map((t: any) => t.plain_text || t.text?.content || '').join('');
        } else if ('rich_text' in rawValue && Array.isArray(rawValue.rich_text)) {
          parsedVal = rawValue.rich_text.map((t: any) => t.plain_text || t.text?.content || '').join('');
        } else if ('number' in rawValue) {
          parsedVal = rawValue.number;
        } else if ('select' in rawValue) {
          parsedVal = rawValue.select?.name || null;
        } else if ('multi_select' in rawValue && Array.isArray(rawValue.multi_select)) {
          parsedVal = rawValue.multi_select.map((m: any) => m.name || m);
        } else if ('date' in rawValue) {
          parsedVal = rawValue.date ? { start: rawValue.date.start, end: rawValue.date.end || null } : null;
        } else if ('checkbox' in rawValue) {
          parsedVal = rawValue.checkbox;
        } else if ('relation' in rawValue && Array.isArray(rawValue.relation)) {
          parsedVal = rawValue.relation.map((r: any) => r.id || r);
        } else if ('start' in rawValue) {
          parsedVal = { start: rawValue.start, end: rawValue.end || null };
        } else {
          parsedVal = rawValue;
        }
      } else {
        parsedVal = rawValue;
      }
    }

    if (parsedVal !== null && parsedVal !== undefined) {
      // Do not produce empty relation as an unexpected extra property
      if (contract.notionType === 'relation' && Array.isArray(parsedVal) && parsedVal.length === 0) {
        continue;
      }
      canonical[propName] = canonicalizePropertyValue(contract, parsedVal);
    }
  }

  return canonical;
}

/**
 * Computes fingerprint directly from a raw Notion page record's properties.
 */
export function calculateRecordFingerprint(
  envKey: string,
  recordProperties: Record<string, any>,
): string {
  const canonical = canonicalizePageRecord(envKey, recordProperties);
  return calculatePropertiesFingerprint(envKey, canonical);
}

