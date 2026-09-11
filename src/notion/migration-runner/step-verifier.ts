import { MigrationStep } from './types';

export interface VerificationResult {
  valid: boolean;
  isCompatible?: boolean;
  reason?: string;
  detail?: string;
}

export const OBLIGATIONS_STATUS_BASELINE_OPTIONS = [
  'Prevista',
  'Pendente',
  'Paga',
  'Atrasada',
  'Dispensada',
] as const;

export const OBLIGATIONS_STATUS_TARGET_OPTIONS = [
  'Prevista',
  'Pendente',
  'Paga',
  'Atrasada',
  'Dispensada',
  'Revisão Necessária',
  'Cancelada',
] as const;

/**
 * Unified structural verifier reused across:
 * 1. Idempotency pre-check
 * 2. Post-mutation verification
 * 3. verifyStepAlreadyCompleted on resume/retry
 */
export class StepStructuralVerifier {
  /**
   * Verifies ALTER_SELECT_OPTIONS on Obrigações Mensais.Status.
   * - requireAllTargetOptions: true for NO_OP check and post-PATCH verification
   * - requireBaselineOptions: true before applying mutation
   */
  public static verifyAlterSelectOptions(
    prop: any,
    options: {
      requireAllTargetOptions?: boolean;
      requireBaselineOptions?: boolean;
    } = {},
  ): VerificationResult {
    if (!prop) {
      return { valid: false, reason: 'STATUS_PROPERTY_MISSING', detail: 'Propriedade Status não encontrada' };
    }

    if (prop.type !== 'select') {
      return {
        valid: false,
        reason: 'STATUS_TYPE_MISMATCH',
        detail: `Propriedade Status possui tipo '${prop.type}', esperado 'select'`,
      };
    }

    const rawOptions = prop.select?.options || prop.selectOptions || [];
    const liveOptions: Array<{ id?: string; name: string }> = Array.isArray(rawOptions)
      ? rawOptions.map((o: any) => (typeof o === 'string' ? { name: o } : o))
      : [];
    const liveNames = new Set(liveOptions.map((o) => o.name));

    if (options.requireBaselineOptions) {
      for (const baseline of OBLIGATIONS_STATUS_BASELINE_OPTIONS) {
        if (!liveNames.has(baseline)) {
          return {
            valid: false,
            reason: 'BASELINE_OPTION_MISSING',
            detail: `Opção essencial '${baseline}' ausente em Obrigações.Status`,
          };
        }
      }
    }

    if (options.requireAllTargetOptions) {
      for (const target of OBLIGATIONS_STATUS_TARGET_OPTIONS) {
        if (!liveNames.has(target)) {
          return {
            valid: false,
            reason: 'TARGET_OPTION_MISSING',
            detail: `Opção homologada '${target}' ausente em Obrigações.Status`,
          };
        }
      }

      // Exact set of 7 options: no extra options permitted
      const targetSet = new Set<string>(OBLIGATIONS_STATUS_TARGET_OPTIONS);
      for (const opt of liveOptions) {
        if (!targetSet.has(opt.name)) {
          return {
            valid: false,
            reason: 'UNEXPECTED_STATUS_OPTION',
            detail: `Opção inesperada '${opt.name}' encontrada em Obrigações.Status pós-Step 1`,
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Verifies CREATE_PROPERTY on existing Data Sources.
   * Compares type and configuration. If type matches but config diverges,
   * flags isCompatible = false and specifies reason.
   */
  public static verifyCreateProperty(
    existingProp: any,
    expectedPayload: Record<string, any>,
    propName: string,
    options: { allowExtraOptions?: boolean } = {},
  ): VerificationResult {
    if (!existingProp) {
      return { valid: false, isCompatible: false, reason: 'PROPERTY_MISSING', detail: `Propriedade '${propName}' ausente` };
    }

    const payloadEntry = Object.values(expectedPayload)[0] as Record<string, any> | undefined;
    if (!payloadEntry) {
      return { valid: false, isCompatible: false, reason: 'INVALID_PAYLOAD', detail: 'Payload sanitizado vazio' };
    }

    const expectedType = Object.keys(payloadEntry)[0];
    if (existingProp.type !== expectedType) {
      return {
        valid: false,
        isCompatible: false,
        reason: 'TYPE_MISMATCH',
        detail: `Propriedade '${propName}' possui tipo '${existingProp.type}', mas o plano exige '${expectedType}'.`,
      };
    }

    // Structural configuration check per property type
    if (expectedType === 'number') {
      const expectedFormat = payloadEntry.number?.format;
      const actualFormat = existingProp.number?.format;
      if (expectedFormat && (!actualFormat || actualFormat !== expectedFormat)) {
        return {
          valid: false,
          isCompatible: false,
          reason: 'FORMAT_MISMATCH',
          detail: `Propriedade de número '${propName}' possui format '${actualFormat || 'ausente'}', mas o plano exige '${expectedFormat}'.`,
        };
      }
    } else if (expectedType === 'select') {
      const expectedOptions: Array<{ name: string }> = payloadEntry.select?.options || [];
      const actualOptions: Array<{ name: string }> =
        existingProp.select?.options || existingProp.selectOptions || [];
      const actualNames = new Set(actualOptions.map((o) => o.name));
      const expectedNames = new Set(expectedOptions.map((o) => o.name));

      for (const expOpt of expectedOptions) {
        if (!actualNames.has(expOpt.name)) {
          return {
            valid: false,
            isCompatible: false,
            reason: 'SELECT_OPTIONS_DIVERGENT',
            detail: `Propriedade select '${propName}' não contém a opção homologada '${expOpt.name}'.`,
          };
        }
      }

      if (!options.allowExtraOptions) {
        for (const actOpt of actualOptions) {
          if (!expectedNames.has(actOpt.name)) {
            return {
              valid: false,
              isCompatible: false,
              reason: 'SELECT_OPTIONS_DIVERGENT',
              detail: `Propriedade select '${propName}' contém opção inesperada '${actOpt.name}'.`,
            };
          }
        }
      }
    } else if (expectedType === 'multi_select') {
      const expectedOptions: Array<{ name: string }> = payloadEntry.multi_select?.options || [];
      const actualOptions: Array<{ name: string }> =
        existingProp.multi_select?.options || existingProp.selectOptions || [];
      const actualNames = new Set(actualOptions.map((o) => o.name));
      const expectedNames = new Set(expectedOptions.map((o) => o.name));

      for (const expOpt of expectedOptions) {
        if (!actualNames.has(expOpt.name)) {
          return {
            valid: false,
            isCompatible: false,
            reason: 'MULTI_SELECT_OPTIONS_DIVERGENT',
            detail: `Propriedade multi_select '${propName}' não contém a opção homologada '${expOpt.name}'.`,
          };
        }
      }

      if (!options.allowExtraOptions) {
        for (const actOpt of actualOptions) {
          if (!expectedNames.has(actOpt.name)) {
            return {
              valid: false,
              isCompatible: false,
              reason: 'MULTI_SELECT_OPTIONS_DIVERGENT',
              detail: `Propriedade multi_select '${propName}' contém opção inesperada '${actOpt.name}'.`,
            };
          }
        }
      }
    } else if (expectedType === 'relation') {
      const expectedTarget = payloadEntry.relation?.data_source_id;
      const actualTarget = existingProp.relation?.data_source_id || existingProp.relationDataSourceId;
      if (expectedTarget && (!actualTarget || expectedTarget !== actualTarget)) {
        return {
          valid: false,
          isCompatible: false,
          reason: 'RELATION_TARGET_MISMATCH',
          detail: `Relation '${propName}' aponta para data_source_id '${actualTarget || 'ausente'}', esperado '${expectedTarget}'.`,
        };
      }
      const expectedRelType = payloadEntry.relation?.type;
      const actualRelType = existingProp.relation?.type || existingProp.relationType;
      if (expectedRelType && (!actualRelType || expectedRelType !== actualRelType)) {
        return {
          valid: false,
          isCompatible: false,
          reason: 'RELATION_TYPE_MISMATCH',
          detail: `Relation '${propName}' possui tipo '${actualRelType || 'ausente'}', esperado '${expectedRelType}'.`,
        };
      }
    }

    return { valid: true, isCompatible: true };
  }

  /**
   * Verifies CREATE_DATABASE (13ª Base: Faturas / Ciclos de Cartão).
   * Validates: active database, exact parent page match, normalized title match, exact migration marker.
   */
  public static verifyDatabase(
    db: any,
    expectedParentPageId: string,
    planHash: string,
  ): VerificationResult {
    if (!db || db.archived || db.in_trash) {
      return { valid: false, reason: 'DATABASE_ARCHIVED_OR_MISSING', detail: 'Database arquivada, na lixeira ou não encontrada' };
    }

    const normActualParent = (db.parent?.page_id || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const normExpectedParent = expectedParentPageId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (!normActualParent || normActualParent !== normExpectedParent) {
      return {
        valid: false,
        reason: 'PARENT_PAGE_MISMATCH',
        detail: `Database pertence ao parent '${db.parent?.page_id}', esperado '${expectedParentPageId}'`,
      };
    }

    const title = (db.title || []).map((t: any) => t.plain_text || t.text?.content || '').join('').trim();
    if (title !== 'Faturas / Ciclos de Cartão') {
      return {
        valid: false,
        reason: 'TITLE_MISMATCH',
        detail: `Título da database '${title}' não corresponde exatamente a 'Faturas / Ciclos de Cartão'`,
      };
    }

    const desc = (db.description || []).map((d: any) => d.plain_text || d.text?.content || '').join(' ');
    const expectedMarker = `MIGRATION_MARKER:${planHash}:CARD_BILLS_V1`;
    if (!desc.includes(expectedMarker)) {
      if (desc.includes('CARD_BILLS_V1')) {
        return {
          valid: false,
          reason: 'FOREIGN_MIGRATION_PLAN_DATABASE',
          detail: `Database possui marker de migração CARD_BILLS_V1 com outro planHash diferente de '${planHash}'`,
        };
      }
      return {
        valid: false,
        reason: 'MIGRATION_MARKER_MISSING',
        detail: `Marker de migração '[${expectedMarker}]' não encontrado na descrição da base`,
      };
    }

    return { valid: true };
  }

  /**
   * Verifies RESOLVE_DATA_SOURCE_ID.
   * Requires unambiguous data_source resolution: exactly 1 candidate, or exactly 1 matching candidate.
   */
  public static verifyResolveDataSource(db: any): {
    valid: boolean;
    dataSourceId?: string;
    reason?: string;
    detail?: string;
  } {
    if (!db) {
      return { valid: false, reason: 'DATABASE_MISSING', detail: 'Database não encontrada' };
    }

    const dataSources = db.data_sources;
    if (!dataSources || !Array.isArray(dataSources) || dataSources.length === 0) {
      return {
        valid: false,
        reason: 'NO_DATA_SOURCES',
        detail: `Nenhum data_source retornado no database '${db.id}'`,
      };
    }

    if (dataSources.length > 1) {
      return {
        valid: false,
        reason: 'AMBIGUOUS_DATA_SOURCE',
        detail: `Database '${db.id}' retornou múltiplos data_sources (${dataSources.length}). Resolução ambígua não permitida.`,
      };
    }

    const dsId = dataSources[0]?.id;
    if (!dsId) {
      return {
        valid: false,
        reason: 'INVALID_DATA_SOURCE_ID',
        detail: `data_sources[0].id é nulo ou indefinido no database '${db.id}'`,
      };
    }

    return { valid: true, dataSourceId: dsId };
  }

  /**
   * Verifies CREATE_DUAL_RELATION on both sides:
   * 1. Transações.'Fatura Vinculada' -> target Faturas, type dual_property, sync 'Lançamentos do Ciclo'
   * 2. Faturas.'Lançamentos do Ciclo' -> target Transações, type dual_property, sync 'Fatura Vinculada'
   */
  public static verifyDualRelation(
    transactionsDs: any,
    billsDs: any,
    expectedBillsDsId: string,
    expectedTxDsId: string,
  ): VerificationResult {
    if (!transactionsDs) {
      return { valid: false, reason: 'TRANSACTIONS_DS_MISSING', detail: 'Data Source Transações não encontrado ou leitura falhou' };
    }
    if (!billsDs) {
      return { valid: false, reason: 'BILLS_DS_MISSING', detail: 'Data Source Faturas não encontrado ou leitura falhou' };
    }

    // 1. Check Transações side
    const txProp = transactionsDs.properties?.['Fatura Vinculada'];
    if (!txProp) {
      return {
        valid: false,
        reason: 'TRANSACTIONS_RELATION_MISSING',
        detail: "Propriedade 'Fatura Vinculada' ausente em Transações",
      };
    }

    if (txProp.type !== 'relation') {
      return {
        valid: false,
        reason: 'TRANSACTIONS_RELATION_TYPE_MISMATCH',
        detail: `Propriedade 'Fatura Vinculada' possui tipo '${txProp.type}', esperado 'relation'`,
      };
    }

    const txRelTarget = txProp.relation?.data_source_id || txProp.relationDataSourceId;
    if (!txRelTarget || txRelTarget !== expectedBillsDsId) {
      return {
        valid: false,
        reason: 'TRANSACTIONS_RELATION_TARGET_MISMATCH',
        detail: `'Fatura Vinculada' aponta para '${txRelTarget || 'ausente'}', esperado '${expectedBillsDsId}'`,
      };
    }

    const txRelType = txProp.relation?.type || txProp.relationType;
    if (!txRelType || txRelType !== 'dual_property') {
      return {
        valid: false,
        reason: 'TRANSACTIONS_RELATION_NOT_DUAL',
        detail: `'Fatura Vinculada' possui tipo de relation '${txRelType || 'ausente'}', esperado 'dual_property'`,
      };
    }

    const txSyncName = txProp.relation?.dual_property?.synced_property_name || txProp.syncedPropertyName;
    if (txSyncName !== 'Lançamentos do Ciclo') {
      return {
        valid: false,
        reason: 'TRANSACTIONS_SYNC_PROPERTY_NAME_MISMATCH',
        detail: `'Fatura Vinculada' sincroniza com '${txSyncName || 'ausente'}', esperado 'Lançamentos do Ciclo'`,
      };
    }

    // 2. Check Faturas side
    const billsProp = billsDs.properties?.['Lançamentos do Ciclo'];
    if (!billsProp) {
      return {
        valid: false,
        reason: 'BILLS_SYNC_PROPERTY_MISSING',
        detail: "Propriedade sincronizada 'Lançamentos do Ciclo' ausente no Data Source Faturas",
      };
    }

    if (billsProp.type !== 'relation') {
      return {
        valid: false,
        reason: 'BILLS_SYNC_PROPERTY_TYPE_MISMATCH',
        detail: `'Lançamentos do Ciclo' possui tipo '${billsProp.type}', esperado 'relation'`,
      };
    }

    const billsRelTarget = billsProp.relation?.data_source_id || billsProp.relationDataSourceId;
    if (!billsRelTarget || billsRelTarget !== expectedTxDsId) {
      return {
        valid: false,
        reason: 'BILLS_RELATION_TARGET_MISMATCH',
        detail: `'Lançamentos do Ciclo' aponta para '${billsRelTarget || 'ausente'}', esperado '${expectedTxDsId}'`,
      };
    }

    const billsRelType = billsProp.relation?.type || billsProp.relationType;
    if (!billsRelType || billsRelType !== 'dual_property') {
      return {
        valid: false,
        reason: 'BILLS_RELATION_NOT_DUAL',
        detail: `'Lançamentos do Ciclo' possui tipo de relation '${billsRelType || 'ausente'}', esperado 'dual_property'`,
      };
    }

    const billsSyncName = billsProp.relation?.dual_property?.synced_property_name || billsProp.syncedPropertyName;
    if (billsSyncName !== 'Fatura Vinculada') {
      return {
        valid: false,
        reason: 'BILLS_SYNC_PROPERTY_NAME_MISMATCH',
        detail: `'Lançamentos do Ciclo' sincroniza com '${billsSyncName || 'ausente'}', esperado 'Fatura Vinculada'`,
      };
    }

    return { valid: true };
  }
}
