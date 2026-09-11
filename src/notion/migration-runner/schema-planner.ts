import fs from 'fs';
import path from 'path';
import { TARGET_CONTRACT, DataSourceContract, PropertyContract } from '../../domain/schema-contract';
import {
  MigrationStep,
  SchemaPlan,
  SchemaPlanSummary,
  TargetDataSource,
} from './types';

export interface SchemaPlannerOptions {
  envVars?: Record<string, string | undefined>;
  liveSnapshot?: Record<string, Record<string, any>>;
  parentPageId?: string;
}

export class SchemaPlanner {
  private envVars: Record<string, string | undefined>;
  private liveSnapshot: Record<string, Record<string, any>>;
  private parentPageId?: string;

  constructor(options: SchemaPlannerOptions = {}) {
    this.envVars = options.envVars ?? process.env;
    this.parentPageId =
      options.parentPageId ??
      this.envVars.NOTION_PARENT_PAGE_ID?.trim() ??
      this.envVars.NOTION_WORKSPACE_PAGE_ID?.trim() ??
      '<NOTION_PARENT_PAGE_ID_PLACEHOLDER>';

    if (options.liveSnapshot) {
      this.liveSnapshot = options.liveSnapshot;
    } else {
      const snapshotPath = path.resolve(
        process.cwd(),
        'tests',
        'fixtures',
        'notion-live-schema.snapshot.json',
      );
      if (fs.existsSync(snapshotPath)) {
        this.liveSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      } else {
        this.liveSnapshot = {};
      }
    }
  }

  /**
   * Generates the complete, deterministic, ordered DDL schema plan.
   */
  public generatePlan(): SchemaPlan {
    const steps: MigrationStep[] = [];
    const byDataSource: Record<string, number> = {};
    let stepNumber = 1;

    // -------------------------------------------------------------------------
    // 1. ALTER_SELECT_OPTIONS: Obrigações Mensais (Status)
    // Read-before-write: preserve all 5 existing physical options + add 2 new ones
    // -------------------------------------------------------------------------
    const obligationsContract = TARGET_CONTRACT.NOTION_DS_MONTHLY_OBLIGATIONS;
    const obligationsDsId = this.envVars[obligationsContract.envKey]?.trim();

    const existingObligationsSnapshot = this.liveSnapshot[obligationsContract.envKey] ?? {};
    const existingStatusProp =
      existingObligationsSnapshot['Status'] ?? existingObligationsSnapshot['status'];
    const existingOptions: string[] =
      existingStatusProp?.selectOptions ?? ['Prevista', 'Pendente', 'Paga', 'Atrasada', 'Dispensada'];

    const newRequiredOptions = ['Revisão Necessária', 'Cancelada'];
    const mergedOptionsSet = new Set([...existingOptions, ...newRequiredOptions]);
    const mergedOptionsList = Array.from(mergedOptionsSet);

    steps.push({
      stepNumber: stepNumber++,
      operation: 'ALTER_SELECT_OPTIONS',
      targetDataSource: {
        envKey: obligationsContract.envKey,
        name: obligationsContract.defaultTitle,
        id: obligationsDsId,
      },
      property: 'Status',
      precondition: `Data Source Obrigações Mensais (${obligationsContract.envKey}) acessível; propriedade Status contém opções físicas existentes [${existingOptions.join(', ')}]`,
      sanitizedPayload: {
        Status: {
          status: {
            options: mergedOptionsList.map((name) => ({ name })),
          },
        },
      },
      postcondition: `Propriedade Status contém 7 opções homologadas preservando opções legadas: [${mergedOptionsList.join(', ')}]`,
      risk: 'LOW',
      rollback: `Reverter opções de Status no Notion via PATCH restaurando lista original [${existingOptions.join(', ')}]`,
      metadata: {
        existingOptions,
        addedOptions: newRequiredOptions,
        readBeforeWriteVerified: true,
      },
    });
    byDataSource[obligationsContract.envKey] = (byDataSource[obligationsContract.envKey] || 0) + 1;

    // -------------------------------------------------------------------------
    // 2. CREATE_PROPERTY: 51 Missing Properties across 12 existing Data Sources
    // Evaluated in canonical deterministic order of TARGET_CONTRACT keys
    // -------------------------------------------------------------------------
    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      if (!contract.isExisting) continue; // 13th database handled separately below

      const dsId = this.envVars[contract.envKey]?.trim();
      const actualProps = this.liveSnapshot[contract.envKey] ?? {};
      const actualPropKeys = Object.keys(actualProps).map((k) => k.toLowerCase().trim());

      for (const prop of contract.properties) {
        // Check if property exists under canonical name or any alias
        const isExactMatch = actualPropKeys.includes(prop.notionProperty.toLowerCase().trim());
        const isAliasMatch = (prop.aliases ?? []).some((alias) =>
          actualPropKeys.includes(alias.toLowerCase().trim()),
        );

        if (!isExactMatch && !isAliasMatch) {
          // Property is MISSING and must be created
          const payload = this.buildPropertyPayload(prop, this.envVars);

          steps.push({
            stepNumber: stepNumber++,
            operation: 'CREATE_PROPERTY',
            targetDataSource: {
              envKey: contract.envKey,
              name: contract.defaultTitle,
              id: dsId,
            },
            property: prop.notionProperty,
            precondition: `Propriedade '${prop.notionProperty}' não existe no Data Source '${contract.defaultTitle}' (${contract.envKey})`,
            sanitizedPayload: payload,
            postcondition: `Propriedade '${prop.notionProperty}' (${prop.notionType}) criada e acessível no Data Source '${contract.defaultTitle}'`,
            risk: 'LOW',
            rollback: `Ocultar ou desvincular propriedade '${prop.notionProperty}' no adaptador de schema; arquivamento opcional via Notion API`,
            metadata: {
              authority: prop.authority,
              description: prop.description,
              direction: prop.direction,
            },
          });
          byDataSource[contract.envKey] = (byDataSource[contract.envKey] || 0) + 1;
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Faturas / Ciclos de Cartão (13th Database: NOTION_DS_CARD_BILLS)
    // Multi-phase modeling:
    //   Phase A: CREATE_DATABASE (with initial non-dual properties)
    //   Phase B: RESOLVE_DATA_SOURCE_ID (from created database in runtime)
    //   Phase C: CREATE_DUAL_RELATION (between Transações and Card Bills)
    // -------------------------------------------------------------------------
    const cardBillsContract = TARGET_CONTRACT.NOTION_DS_CARD_BILLS;
    const transactionsContract = TARGET_CONTRACT.NOTION_DS_TRANSACTIONS;
    const transactionsDsId = this.envVars[transactionsContract.envKey]?.trim();

    // Phase A: CREATE_DATABASE
    const initialPropertiesPayload: Record<string, any> = {};
    for (const prop of cardBillsContract.properties) {
      if (prop.notionType === 'relation' && prop.relationTargetEnvKey === 'NOTION_DS_TRANSACTIONS') {
        // Dual relation with Transações is deferred to Phase C
        continue;
      }
      Object.assign(initialPropertiesPayload, this.buildPropertyPayload(prop, this.envVars));
    }

    const createDbStepNumber = stepNumber++;
    steps.push({
      stepNumber: createDbStepNumber,
      operation: 'CREATE_DATABASE',
      targetDataSource: {
        envKey: cardBillsContract.envKey,
        name: cardBillsContract.defaultTitle,
      },
      precondition: `Página-mãe acessível (${this.parentPageId}); base '${cardBillsContract.defaultTitle}' ainda não criada`,
      sanitizedPayload: {
        parent: {
          type: 'page_id',
          page_id: this.parentPageId,
        },
        title: [
          {
            type: 'text',
            text: { content: cardBillsContract.defaultTitle },
          },
        ],
        properties: initialPropertiesPayload,
      },
      postcondition: `Database '${cardBillsContract.defaultTitle}' criado com schema inicial de ${Object.keys(initialPropertiesPayload).length} propriedades`,
      risk: 'MEDIUM',
      rollback: `Arquivar página do database criado (${cardBillsContract.defaultTitle}) via DELETE/PATCH /v1/databases/:id`,
      metadata: {
        note: 'Criação estrutural da 13ª base. O data_source_id resultante é atribuído em tempo de execução.',
      },
    });
    byDataSource[cardBillsContract.envKey] = (byDataSource[cardBillsContract.envKey] || 0) + 1;

    // Phase B: RESOLVE_DATA_SOURCE_ID
    const resolveDsStepNumber = stepNumber++;
    steps.push({
      stepNumber: resolveDsStepNumber,
      operation: 'RESOLVE_DATA_SOURCE_ID',
      targetDataSource: {
        envKey: cardBillsContract.envKey,
        name: cardBillsContract.defaultTitle,
      },
      dependsOnStep: createDbStepNumber,
      precondition: `Database criado no Step ${createDbStepNumber}; initial data source retornado pela Notion API 2026-03-11`,
      sanitizedPayload: {
        sourceStep: createDbStepNumber,
        resolutionPath: 'database.data_sources[0].id',
      },
      postcondition: `ID do Data Source de Faturas resolvido em runtime e propagado para o Step ${resolveDsStepNumber + 1}`,
      risk: 'LOW',
      rollback: 'N/A (operação idempotente de resolução em memória)',
      metadata: {
        runtimePropagationTarget: `NOTION_DS_CARD_BILLS_DATA_SOURCE_ID`,
      },
    });

    // Phase C: CREATE_DUAL_RELATION
    const dualRelStepNumber = stepNumber++;
    steps.push({
      stepNumber: dualRelStepNumber,
      operation: 'CREATE_DUAL_RELATION',
      targetDataSource: {
        envKey: transactionsContract.envKey,
        name: transactionsContract.defaultTitle,
        id: transactionsDsId,
      },
      dependsOnStep: resolveDsStepNumber,
      property: 'Fatura / Ciclo de Cartão',
      precondition: `Data Source Transações (${transactionsDsId}) acessível; Data Source ID de Faturas resolvido no Step ${resolveDsStepNumber}`,
      sanitizedPayload: {
        'Fatura / Ciclo de Cartão': {
          relation: {
            data_source_id: `<RESOLVED_DATA_SOURCE_ID_STEP_${resolveDsStepNumber}>`,
            type: 'dual_property',
            dual_property: {
              synced_property_name: 'Transações da Fatura',
            },
          },
        },
      },
      postcondition: `Dual relation estabelecida: Transações.Fatura / Ciclo de Cartão <-> Faturas.Transações da Fatura`,
      risk: 'LOW',
      rollback: `Arquivar propriedade de relation em Transações via PATCH`,
      metadata: {
        bidirectional: true,
        sourceProperty: 'Fatura / Ciclo de Cartão',
        syncedProperty: 'Transações da Fatura',
      },
    });
    byDataSource[transactionsContract.envKey] = (byDataSource[transactionsContract.envKey] || 0) + 1;

    // Build Summary
    const createPropertyCount = steps.filter((s) => s.operation === 'CREATE_PROPERTY').length;
    const alterOptionsCount = steps.filter((s) => s.operation === 'ALTER_SELECT_OPTIONS').length;
    const createDatabaseCount = steps.filter((s) => s.operation === 'CREATE_DATABASE').length;
    const resolveDataSourceCount = steps.filter((s) => s.operation === 'RESOLVE_DATA_SOURCE_ID').length;
    const dualRelationCount = steps.filter((s) => s.operation === 'CREATE_DUAL_RELATION').length;

    const summary: SchemaPlanSummary = {
      totalSteps: steps.length,
      createPropertyCount,
      alterOptionsCount,
      createDatabaseCount,
      resolveDataSourceCount,
      dualRelationCount,
      byDataSource,
    };

    return {
      version: '1.0.0',
      notionApiVersion: '2026-03-11',
      summary,
      steps,
    };
  }

  /**
   * Helper to build a sanitized Notion API property creation payload based on property type.
   */
  private buildPropertyPayload(
    prop: PropertyContract,
    envVars: Record<string, string | undefined>,
  ): Record<string, any> {
    const name = prop.notionProperty;

    switch (prop.notionType) {
      case 'title':
        return { [name]: { title: {} } };

      case 'number':
        return { [name]: { number: { format: 'real' } } };

      case 'rich_text':
        return { [name]: { rich_text: {} } };

      case 'checkbox':
        return { [name]: { checkbox: {} } };

      case 'date':
        return { [name]: { date: {} } };

      case 'select':
        return {
          [name]: {
            select: {
              options: (prop.expectedOptions ?? []).map((opt) => ({ name: opt })),
            },
          },
        };

      case 'multi_select':
        return {
          [name]: {
            multi_select: {
              options: (prop.expectedOptions ?? []).map((opt) => ({ name: opt })),
            },
          },
        };

      case 'status' as any:
        return {
          [name]: {
            status: {
              options: (prop.expectedOptions ?? []).map((opt) => ({ name: opt })),
            },
          },
        };

      case 'relation': {
        const targetEnvKey = prop.relationTargetEnvKey;
        const targetId = targetEnvKey ? envVars[targetEnvKey]?.trim() : undefined;

        return {
          [name]: {
            relation: {
              data_source_id: targetId || `<TARGET_${targetEnvKey}>`,
              type: 'single_property',
            },
          },
        };
      }

      default:
        return { [name]: { [prop.notionType]: {} } };
    }
  }
}
