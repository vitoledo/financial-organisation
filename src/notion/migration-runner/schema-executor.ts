import { Client } from '@notionhq/client';
import { CompleteMigrationPlan, DdlApplyExecutionSummary, DdlStepExecutionResult, MigrationStep } from './types';
import { MigrationJournal } from './journal';

export interface SchemaApplyExecutorOptions {
  client: Client;
  journal: MigrationJournal;
  plan: CompleteMigrationPlan;
  envVars?: Record<string, string | undefined>;
  parentPageId?: string;
  allowRealMutations?: boolean;
}

export class SchemaApplyExecutor {
  private client: Client;
  private journal: MigrationJournal;
  private plan: CompleteMigrationPlan;
  private envVars: Record<string, string | undefined>;
  private parentPageId?: string;
  private allowRealMutations: boolean;

  constructor(options: SchemaApplyExecutorOptions) {
    this.client = options.client;
    this.journal = options.journal;
    this.plan = options.plan;
    this.envVars = options.envVars ?? process.env;
    this.parentPageId = options.parentPageId ?? this.envVars.NOTION_PARENT_PAGE_ID?.trim();
    // Strictly FALSE by default (physical mutation gate)
    this.allowRealMutations = options.allowRealMutations ?? false;
  }

  /**
   * Executes the 54 deterministic DDL schema steps with crash resilience,
   * live read-before-write, post-mutation verification, and durable SQLite journal recording.
   * Strictly blocked when allowRealMutations is false.
   */
  public async executeDdlPlan(runId: string, commitSha: string, gitBranch: string): Promise<DdlApplyExecutionSummary> {
    const startedAt = new Date().toISOString();
    const planHash = this.plan.planHash;
    const steps = this.plan.schemaPlan.steps;
    const stepResults: DdlStepExecutionResult[] = [];

    // Safeguard Gate: Block actual mutations if allowRealMutations is not enabled
    if (!this.allowRealMutations) {
      throw new Error(
        'MUTAÇÕES REAIS BLOQUEADAS: A execução física (apply) de modificações no Notion permanece desabilitada nesta fase. Conclua a validação do runner e o gate de aprovação antes de habilitar mutations.',
      );
    }

    this.journal.startRun({
      runId,
      planHash,
      commitSha,
      gitBranch,
    });

    try {
      let resolvedCardBillsDsId = this.journal.getResolvedDataSourceId(planHash);

      for (const step of steps) {
        const stepStartTime = Date.now();
        const existingStatus = this.journal.getStepStatus(planHash, step.stepNumber);

        // Check if step was already completed in a previous attempt
        if (existingStatus && (existingStatus.status === 'VERIFIED' || existingStatus.status === 'NO_OP_VERIFIED')) {
          const isStillValid = await this.verifyStepAlreadyCompleted(step, resolvedCardBillsDsId);
          if (isStillValid) {
            stepResults.push({
              stepNumber: step.stepNumber,
              operation: step.operation,
              status: existingStatus.status,
              targetDataSource: step.targetDataSource.name,
              property: step.property,
              createdId: existingStatus.createdId,
              detail: `Passo já registrado e verificado como ${existingStatus.status} no journal SQLite. Revalidação live confirmada.`,
              durationMs: Date.now() - stepStartTime,
            });

            if (step.operation === 'RESOLVE_DATA_SOURCE_ID' && existingStatus.createdId) {
              resolvedCardBillsDsId = existingStatus.createdId;
            }
            continue;
          }
        }

        // Record PENDING in journal
        this.journal.recordStepPending({
          planHash,
          stepNumber: step.stepNumber,
          operation: step.operation,
          targetDataSource: step.targetDataSource.name,
          targetDataSourceId: step.targetDataSource.id,
          propertyName: step.property,
          metadata: {
            risk: step.risk,
            rollbackPlanned: step.rollback,
          },
        });

        // Dispatch step execution
        let result: DdlStepExecutionResult;

        switch (step.operation) {
          case 'ALTER_SELECT_OPTIONS':
            result = await this.executeAlterSelectOptions(step, stepStartTime);
            break;

          case 'CREATE_PROPERTY':
            result = await this.executeCreateProperty(step, stepStartTime);
            break;

          case 'CREATE_DATABASE':
            result = await this.executeCreateDatabase(step, stepStartTime);
            break;

          case 'RESOLVE_DATA_SOURCE_ID':
            result = await this.executeResolveDataSourceId(step, stepStartTime);
            resolvedCardBillsDsId = result.createdId;
            break;

          case 'CREATE_DUAL_RELATION':
            result = await this.executeCreateDualRelation(step, resolvedCardBillsDsId, stepStartTime);
            break;

          default:
            throw new Error(`Operação não suportada no executor DDL: ${(step as any).operation}`);
        }

        stepResults.push(result);
      }

      this.journal.completeRun(runId);

      return {
        runId,
        planHash,
        commitSha,
        gitBranch,
        totalSteps: steps.length,
        verifiedCount: stepResults.filter((r) => r.status === 'VERIFIED').length,
        noOpCount: stepResults.filter((r) => r.status === 'NO_OP_VERIFIED').length,
        startedAt,
        completedAt: new Date().toISOString(),
        stepResults,
      };
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.journal.failRun(runId, errorMsg);
      throw err;
    }
  }

  /**
   * Re-verifies live postcondition for a step already recorded as completed.
   */
  private async verifyStepAlreadyCompleted(
    step: MigrationStep,
    resolvedCardBillsDsId?: string,
  ): Promise<boolean> {
    try {
      if (step.operation === 'CREATE_PROPERTY') {
        const dsId = step.targetDataSource.id;
        if (!dsId) return false;
        const ds = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
        return !!ds?.properties?.[step.property!];
      }

      if (step.operation === 'ALTER_SELECT_OPTIONS') {
        const dsId = step.targetDataSource.id;
        if (!dsId) return false;
        const ds = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
        const options: Array<{ name: string }> = ds?.properties?.['Status']?.select?.options || [];
        const names = new Set(options.map((o) => o.name));
        return names.has('Revisão Necessária') && names.has('Cancelada');
      }

      if (step.operation === 'CREATE_DATABASE') {
        const dbId = this.journal.getCreatedDatabaseId(this.plan.planHash);
        if (!dbId) return false;
        const db = (await this.client.databases.retrieve({ database_id: dbId })) as any;
        return !db.archived;
      }

      if (step.operation === 'RESOLVE_DATA_SOURCE_ID') {
        return !!resolvedCardBillsDsId;
      }

      if (step.operation === 'CREATE_DUAL_RELATION') {
        const dsId = step.targetDataSource.id;
        if (!dsId || !resolvedCardBillsDsId) return false;
        const ds = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
        const rel = ds?.properties?.['Fatura Vinculada']?.relation;
        return rel?.data_source_id === resolvedCardBillsDsId;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Step 1: ALTER_SELECT_OPTIONS on Obrigações Mensais.Status.
   * Read-before-write, preserves existing option IDs without color, appends 2 new options.
   */
  private async executeAlterSelectOptions(
    step: MigrationStep,
    startTime: number,
  ): Promise<DdlStepExecutionResult> {
    const dsId = step.targetDataSource.id;
    if (!dsId) {
      throw new Error(`Data Source ID ausente para ${step.targetDataSource.name}`);
    }

    // 1. Live Precondition Read
    const currentDs = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
    const statusProp = currentDs.properties?.['Status'];
    if (!statusProp || statusProp.type !== 'select') {
      throw new Error(`SCHEMA_DRIFT: Propriedade Status em ${step.targetDataSource.name} não é do tipo select`);
    }

    const liveOptions: Array<{ id?: string; name: string; color?: string }> =
      statusProp.select?.options || [];
    const liveNames = new Set(liveOptions.map((o) => o.name));

    // Check if already applied (idempotency check)
    const hasRevisao = liveNames.has('Revisão Necessária');
    const hasCancelada = liveNames.has('Cancelada');

    if (hasRevisao && hasCancelada && liveOptions.length >= 7) {
      this.journal.recordStepNoOp(this.plan.planHash, step.stepNumber, {
        operation: step.operation,
        targetDataSource: step.targetDataSource.name,
        targetDataSourceId: dsId,
        propertyName: 'Status',
        metadata: {
          existingOptionsCount: liveOptions.length,
          idempotentState: 'ALREADY_COMPATIBLE',
        },
      });

      return {
        stepNumber: step.stepNumber,
        operation: step.operation,
        status: 'NO_OP_VERIFIED',
        targetDataSource: step.targetDataSource.name,
        property: 'Status',
        detail: 'Opções Revisão Necessária e Cancelada já existem no Notion. Operação registrada como NO_OP_VERIFIED.',
        durationMs: Date.now() - startTime,
      };
    }

    // Safety verification: all baseline options must be present
    const requiredBaseline = ['Prevista', 'Pendente', 'Paga', 'Atrasada', 'Dispensada'];
    for (const req of requiredBaseline) {
      if (!liveNames.has(req)) {
        throw new Error(
          `SCHEMA_DRIFT_PRECONDITION_FAILED: Opção física essencial '${req}' ausente em Obrigações.Status antes do PATCH. Abortando.`,
        );
      }
    }

    // Build merged payload preserving existing IDs without color
    const mergedPayloadOptions: Array<{ id?: string; name: string }> = [];
    for (const opt of liveOptions) {
      mergedPayloadOptions.push({
        ...(opt.id ? { id: opt.id } : {}),
        name: opt.name,
      });
    }

    if (!hasRevisao) mergedPayloadOptions.push({ name: 'Revisão Necessária' });
    if (!hasCancelada) mergedPayloadOptions.push({ name: 'Cancelada' });

    // 2. Perform Mutation
    await (this.client.dataSources as any).update({
      data_source_id: dsId,
      properties: {
        Status: {
          select: {
            options: mergedPayloadOptions,
          },
        },
      },
    });

    this.journal.recordStepApplied(this.plan.planHash, step.stepNumber, undefined, {
      optionsSubmittedCount: mergedPayloadOptions.length,
    });

    // 3. Live Postcondition Verification
    const verifiedDs = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
    const postOptions: Array<{ name: string }> = verifiedDs.properties?.['Status']?.select?.options || [];
    const postNames = new Set(postOptions.map((o) => o.name));

    if (!postNames.has('Revisão Necessária') || !postNames.has('Cancelada')) {
      const err = 'POSTCONDITION_FAILED: Opções não confirmadas na releitura pós-PATCH de Obrigações.Status.';
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    this.journal.recordStepVerified(this.plan.planHash, step.stepNumber, undefined, {
      verifiedOptionsCount: postOptions.length,
    });

    return {
      stepNumber: step.stepNumber,
      operation: step.operation,
      status: 'VERIFIED',
      targetDataSource: step.targetDataSource.name,
      property: 'Status',
      detail: `Opções atualizadas com sucesso para ${postOptions.length} itens preservando IDs legados.`,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Steps 2..51: CREATE_PROPERTY on existing Data Sources.
   * Pre-read, checks idempotency / conflicts, creates property, post-read verification.
   */
  private async executeCreateProperty(
    step: MigrationStep,
    startTime: number,
  ): Promise<DdlStepExecutionResult> {
    const dsId = step.targetDataSource.id;
    const propName = step.property!;
    if (!dsId) throw new Error(`Data Source ID ausente para ${step.targetDataSource.name}`);

    // 1. Live Precondition Read
    const currentDs = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
    const existingProp = currentDs.properties?.[propName];

    if (existingProp) {
      const expectedType = Object.values(step.sanitizedPayload)[0] ? Object.keys(Object.values(step.sanitizedPayload)[0])[0] : undefined;
      if (expectedType && existingProp.type !== expectedType) {
        const err = `SCHEMA_INCOMPATIBLE: Propriedade '${propName}' já existe no Data Source '${step.targetDataSource.name}' com tipo '${existingProp.type}', mas o plano exige '${expectedType}'.`;
        this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
        throw new Error(err);
      }

      this.journal.recordStepNoOp(this.plan.planHash, step.stepNumber, {
        operation: step.operation,
        targetDataSource: step.targetDataSource.name,
        targetDataSourceId: dsId,
        propertyName: propName,
        existingId: existingProp.id,
        metadata: { existingType: existingProp.type, idempotent: true },
      });

      return {
        stepNumber: step.stepNumber,
        operation: step.operation,
        status: 'NO_OP_VERIFIED',
        targetDataSource: step.targetDataSource.name,
        property: propName,
        createdId: existingProp.id,
        detail: `Propriedade '${propName}' já existe com tipo compatível no Notion. Registrado como NO_OP_VERIFIED.`,
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Perform Mutation
    await (this.client.dataSources as any).update({
      data_source_id: dsId,
      properties: step.sanitizedPayload,
    });

    this.journal.recordStepApplied(this.plan.planHash, step.stepNumber);

    // 3. Live Postcondition Verification
    const verifiedDs = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
    const createdProp = verifiedDs.properties?.[propName];

    if (!createdProp) {
      const err = `POSTCONDITION_FAILED: Propriedade '${propName}' não encontrada na releitura pós-criação no Data Source '${step.targetDataSource.name}'.`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    this.journal.recordStepVerified(this.plan.planHash, step.stepNumber, createdProp.id, {
      notionType: createdProp.type,
    });

    return {
      stepNumber: step.stepNumber,
      operation: step.operation,
      status: 'VERIFIED',
      targetDataSource: step.targetDataSource.name,
      property: propName,
      createdId: createdProp.id,
      detail: `Propriedade '${propName}' criada com sucesso (ID: ${createdProp.id}).`,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Step 52: CREATE_DATABASE (13ª Base: Faturas / Ciclos de Cartão).
   * Crash-resilient: reconciles existing database by migration marker under parent page.
   */
  private async executeCreateDatabase(
    step: MigrationStep,
    startTime: number,
  ): Promise<DdlStepExecutionResult> {
    const parentPageId = this.parentPageId;
    if (!parentPageId) {
      throw new Error('NOTION_PARENT_PAGE_ID obrigatório para criar a database Faturas / Ciclos de Cartão.');
    }

    const migrationMarker = `MIGRATION_MARKER:${this.plan.planHash}:CARD_BILLS_V1`;

    // 1. Crash Recovery / Reconciliation Check
    let existingDbId = this.journal.getCreatedDatabaseId(this.plan.planHash);

    if (!existingDbId) {
      // Search for candidate databases under parent page
      try {
        const searchRes = (await this.client.search({
          query: 'Faturas / Ciclos de Cartão',
          filter: { value: 'data_source', property: 'object' },
        })) as any;

        const candidates = (searchRes.results || []).filter((db: any) => {
          const isParentMatch = db.parent?.page_id?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() ===
            parentPageId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const descContent = (db.description || []).map((d: any) => d.plain_text || d.text?.content || '').join(' ');
          const isMarkerMatch = descContent.includes(this.plan.planHash) || descContent.includes('CARD_BILLS_V1');
          return isParentMatch && (isMarkerMatch || db.title?.[0]?.plain_text === 'Faturas / Ciclos de Cartão');
        });

        if (candidates.length === 1) {
          existingDbId = candidates[0].id;
        } else if (candidates.length > 1) {
          throw new Error(
            `AMBIGUOUS_DATABASE: Encontradas ${candidates.length} bases candidatas para Faturas sob a página-mãe. Abortando para evitar duplicidade.`,
          );
        }
      } catch (err: any) {
        if (err.message?.includes('AMBIGUOUS_DATABASE')) throw err;
        // Proceed to creation if search is unsupported or fails
      }
    }

    if (existingDbId) {
      const liveDb = (await this.client.databases.retrieve({ database_id: existingDbId })) as any;
      if (!liveDb.archived) {
        this.journal.recordStepNoOp(this.plan.planHash, step.stepNumber, {
          operation: step.operation,
          targetDataSource: step.targetDataSource.name,
          existingId: existingDbId,
          metadata: { reconciledDatabaseId: existingDbId, crashRecovery: true },
        });

        return {
          stepNumber: step.stepNumber,
          operation: step.operation,
          status: 'NO_OP_VERIFIED',
          targetDataSource: step.targetDataSource.name,
          createdId: existingDbId,
          detail: `Database existente reconciliada com sucesso sob a página-mãe (ID: ${existingDbId}).`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 2. Perform Creation via initial_data_source with migration marker in description
    const creationPayload: any = {
      ...step.sanitizedPayload,
      description: [
        {
          type: 'text',
          text: {
            content: `Base canônica de faturas e ciclos de cartão. [${migrationMarker}]`,
          },
        },
      ],
    };

    const createdDb = (await this.client.databases.create(creationPayload)) as any;
    const dbId = createdDb.id;

    // Immediately persist database.id to SQLite journal
    this.journal.recordStepApplied(this.plan.planHash, step.stepNumber, dbId, {
      databaseId: dbId,
      parentPageId,
      migrationMarker,
    });

    // 3. Postcondition Verification
    const verifiedDb = (await this.client.databases.retrieve({ database_id: dbId })) as any;
    if (!verifiedDb || verifiedDb.archived) {
      const err = `POSTCONDITION_FAILED: Database criada ${dbId} não pôde ser recuperada ou está arquivada.`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    this.journal.recordStepVerified(this.plan.planHash, step.stepNumber, dbId, {
      databaseId: dbId,
    });

    return {
      stepNumber: step.stepNumber,
      operation: step.operation,
      status: 'VERIFIED',
      targetDataSource: step.targetDataSource.name,
      createdId: dbId,
      detail: `Database '${step.targetDataSource.name}' criada com sucesso via initial_data_source (ID: ${dbId}).`,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Step 53: RESOLVE_DATA_SOURCE_ID.
   * Executes GET /v1/databases/{database.id}, validates data_sources, extracts data_sources[0].id.
   */
  private async executeResolveDataSourceId(
    step: MigrationStep,
    startTime: number,
  ): Promise<DdlStepExecutionResult> {
    const dbId = this.journal.getCreatedDatabaseId(this.plan.planHash);
    if (!dbId) {
      throw new Error('RESOLVE_PRECONDITION_FAILED: database.id do Step 52 não encontrado no journal.');
    }

    // Live Read: GET /v1/databases/{database.id}
    const db = (await this.client.databases.retrieve({ database_id: dbId })) as any;

    if (!db.data_sources || !Array.isArray(db.data_sources) || db.data_sources.length === 0) {
      const err = `RESOLVE_DATA_SOURCE_FAILED: Notion API não retornou nenhum data_source no database ${dbId}.`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    const resolvedDsId = db.data_sources[0].id;
    if (!resolvedDsId) {
      const err = `RESOLVE_DATA_SOURCE_FAILED: data_sources[0].id inválido ou nulo no database ${dbId}.`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    this.journal.recordStepVerified(this.plan.planHash, step.stepNumber, resolvedDsId, {
      databaseId: dbId,
      resolvedDataSourceId: resolvedDsId,
      totalDataSources: db.data_sources.length,
    });

    return {
      stepNumber: step.stepNumber,
      operation: step.operation,
      status: 'VERIFIED',
      targetDataSource: step.targetDataSource.name,
      createdId: resolvedDsId,
      detail: `Data Source ID resolvido com sucesso via GET /v1/databases/${dbId}: ${resolvedDsId}`,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Step 54: CREATE_DUAL_RELATION (Transações.Fatura Vinculada <-> Faturas.Lançamentos do Ciclo).
   * Verifies existing relation, creates if missing, confirms dual sync property.
   */
  private async executeCreateDualRelation(
    step: MigrationStep,
    resolvedCardBillsDsId: string | undefined,
    startTime: number,
  ): Promise<DdlStepExecutionResult> {
    const transactionsDsId = step.targetDataSource.id;
    if (!transactionsDsId) throw new Error('Data Source ID de Transações ausente para criar dual relation.');
    if (!resolvedCardBillsDsId) throw new Error('Data Source ID de Faturas não resolvido para vincular dual relation.');

    // 1. Live Precondition Read
    const txDs = (await this.client.dataSources.retrieve({ data_source_id: transactionsDsId })) as any;
    const existingRelProp = txDs.properties?.['Fatura Vinculada'];

    if (existingRelProp) {
      const relTarget = existingRelProp.relation?.data_source_id;
      const syncName = existingRelProp.relation?.dual_property?.synced_property_name;

      if (relTarget === resolvedCardBillsDsId && syncName === 'Lançamentos do Ciclo') {
        this.journal.recordStepNoOp(this.plan.planHash, step.stepNumber, {
          operation: step.operation,
          targetDataSource: step.targetDataSource.name,
          targetDataSourceId: transactionsDsId,
          propertyName: 'Fatura Vinculada',
          existingId: existingRelProp.id,
          metadata: { targetDataSourceId: resolvedCardBillsDsId, dualPropertySynced: syncName },
        });

        return {
          stepNumber: step.stepNumber,
          operation: step.operation,
          status: 'NO_OP_VERIFIED',
          targetDataSource: step.targetDataSource.name,
          property: 'Fatura Vinculada',
          createdId: existingRelProp.id,
          detail: `Dual relation 'Fatura Vinculada' já existe exatamente vinculada a '${resolvedCardBillsDsId}'. Registrado como NO_OP_VERIFIED.`,
          durationMs: Date.now() - startTime,
        };
      }

      const err = `RELATION_CONFLICT: Propriedade 'Fatura Vinculada' já existe em Transações com configuração divergente (target=${relTarget}, sync=${syncName}).`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    // 2. Perform Mutation with actual resolved data_source_id
    const dualRelationPayload = {
      'Fatura Vinculada': {
        relation: {
          data_source_id: resolvedCardBillsDsId,
          type: 'dual_property',
          dual_property: {
            synced_property_name: 'Lançamentos do Ciclo',
          },
        },
      },
    };

    await (this.client.dataSources as any).update({
      data_source_id: transactionsDsId,
      properties: dualRelationPayload,
    });

    this.journal.recordStepApplied(this.plan.planHash, step.stepNumber);

    // 3. Postcondition Verification
    const verifiedTxDs = (await this.client.dataSources.retrieve({ data_source_id: transactionsDsId })) as any;
    const createdRel = verifiedTxDs.properties?.['Fatura Vinculada'];

    if (!createdRel || createdRel.relation?.data_source_id !== resolvedCardBillsDsId) {
      const err = `POSTCONDITION_FAILED: Dual relation 'Fatura Vinculada' não pôde ser confirmada após criação.`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    this.journal.recordStepVerified(this.plan.planHash, step.stepNumber, createdRel.id, {
      relationTarget: resolvedCardBillsDsId,
      syncedPropertyName: 'Lançamentos do Ciclo',
    });

    return {
      stepNumber: step.stepNumber,
      operation: step.operation,
      status: 'VERIFIED',
      targetDataSource: step.targetDataSource.name,
      property: 'Fatura Vinculada',
      createdId: createdRel.id,
      detail: `Dual relation 'Fatura Vinculada' criada com sucesso e sincronizada com 'Lançamentos do Ciclo' (ID: ${createdRel.id}).`,
      durationMs: Date.now() - startTime,
    };
  }
}
