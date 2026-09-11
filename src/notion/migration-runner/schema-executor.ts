import { Client } from '@notionhq/client';
import { CompleteMigrationPlan, DdlApplyExecutionSummary, DdlStepExecutionResult, MigrationStep } from './types';
import { MigrationJournal } from './journal';
import { StepStructuralVerifier } from './step-verifier';
import { SchemaPlanner } from './schema-planner';

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

  private getExpectedCardBillsInitialProperties(): Record<string, any> {
    const createDbStep = this.plan.schemaPlan.steps.find((s) => s.operation === 'CREATE_DATABASE');
    const properties = createDbStep?.sanitizedPayload?.initial_data_source?.properties;
    if (properties && typeof properties === 'object') {
      return properties;
    }
    // Fallback to generating from schema planner if step 52 is not in this specific sub-plan/test
    const planner = new SchemaPlanner({ envVars: this.envVars });
    const fullPlan = planner.generatePlan();
    const fullCreateDbStep = fullPlan.steps.find((s: any) => s.operation === 'CREATE_DATABASE');
    const fallbackProperties = fullCreateDbStep?.sanitizedPayload?.initial_data_source?.properties;
    if (fallbackProperties && typeof fallbackProperties === 'object') {
      return fallbackProperties;
    }
    throw new Error('CONFIG_ERROR: initial_data_source.properties não encontrado no passo CREATE_DATABASE do plano.');
  }

  /**
   * Re-verifies live postcondition for a step already recorded as completed.
   * Utilizes unified StepStructuralVerifier to ensure zero regression.
   */
  private async verifyStepAlreadyCompleted(
    step: MigrationStep,
    resolvedCardBillsDsId?: string,
  ): Promise<boolean> {
    try {
      if (step.operation === 'CREATE_PROPERTY') {
        const dsId = step.targetDataSource.id;
        const propName = step.property!;
        if (!dsId) return false;

        const ds = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
        const prop = ds?.properties?.[propName];
        if (!prop) return false;

        const verif = StepStructuralVerifier.verifyCreateProperty(prop, step.sanitizedPayload, propName);
        if (!verif.valid || !verif.isCompatible) {
          this.journal.recordRevalidationFailed(this.plan.planHash, step.stepNumber, verif.detail ?? 'Revalidação falhou');
          return false;
        }
        return true;
      }

      if (step.operation === 'ALTER_SELECT_OPTIONS') {
        const dsId = step.targetDataSource.id;
        if (!dsId) return false;
        const ds = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
        const statusProp = ds?.properties?.['Status'];
        const verif = StepStructuralVerifier.verifyAlterSelectOptions(statusProp, { requireAllTargetOptions: true });
        if (!verif.valid) {
          this.journal.recordRevalidationFailed(this.plan.planHash, step.stepNumber, verif.detail ?? 'Revalidação falhou');
          return false;
        }
        return true;
      }

      if (step.operation === 'CREATE_DATABASE') {
        const dbId = this.journal.getCreatedDatabaseId(this.plan.planHash);
        if (!dbId || !this.parentPageId) return false;
        const db = (await this.client.databases.retrieve({ database_id: dbId })) as any;
        const verif = StepStructuralVerifier.verifyDatabase(db, this.parentPageId, this.plan.planHash);
        if (!verif.valid) {
          this.journal.recordRevalidationFailed(this.plan.planHash, step.stepNumber, verif.detail ?? 'Revalidação falhou');
          return false;
        }
        return true;
      }

      if (step.operation === 'RESOLVE_DATA_SOURCE_ID') {
        const dbId = this.journal.getCreatedDatabaseId(this.plan.planHash);
        if (!dbId || !resolvedCardBillsDsId) return false;
        const db = (await this.client.databases.retrieve({ database_id: dbId })) as any;
        const verif = StepStructuralVerifier.verifyResolveDataSource(db);
        if (!verif.valid || verif.dataSourceId !== resolvedCardBillsDsId) {
          this.journal.recordRevalidationFailed(this.plan.planHash, step.stepNumber, verif.detail ?? 'Revalidação falhou');
          return false;
        }

        // Validate initial properties
        try {
          const billsDs = (await this.client.dataSources.retrieve({ data_source_id: resolvedCardBillsDsId })) as any;
          const initialProps = this.getExpectedCardBillsInitialProperties();
          const propsVerif = StepStructuralVerifier.verifyCardBillsInitialProperties(
            billsDs,
            initialProps,
            { allowSyncedDualRelation: true },
          );
          if (!propsVerif.valid) {
            this.journal.recordRevalidationFailed(
              this.plan.planHash,
              step.stepNumber,
              propsVerif.detail ?? 'Revalidação de propriedades iniciais falhou',
            );
            return false;
          }
        } catch (readErr: any) {
          this.journal.recordRevalidationFailed(
            this.plan.planHash,
            step.stepNumber,
            `Falha na leitura do data source: ${readErr?.message || String(readErr)}`,
          );
          return false;
        }

        return true;
      }

      if (step.operation === 'CREATE_DUAL_RELATION') {
        const dsId = step.targetDataSource.id;
        if (!dsId || !resolvedCardBillsDsId) return false;
        let txDs: any;
        let billsDs: any;
        try {
          txDs = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
          billsDs = (await this.client.dataSources.retrieve({ data_source_id: resolvedCardBillsDsId })) as any;
        } catch (readErr: any) {
          this.journal.recordRevalidationFailed(
            this.plan.planHash,
            step.stepNumber,
            `Falha ao ler Data Sources para dual relation: ${readErr?.message || String(readErr)}`,
          );
          return false;
        }
        const verif = StepStructuralVerifier.verifyDualRelation(txDs, billsDs, resolvedCardBillsDsId, dsId);
        if (!verif.valid) {
          this.journal.recordRevalidationFailed(this.plan.planHash, step.stepNumber, verif.detail ?? 'Revalidação falhou');
          return false;
        }

        // Final verification of complete Faturas database schema (all 23 properties)
        const initialProps = this.getExpectedCardBillsInitialProperties();
        const finalVerif = StepStructuralVerifier.verifyCardBillsFinalSchema(
          billsDs,
          initialProps,
          dsId,
        );
        if (!finalVerif.valid) {
          this.journal.recordRevalidationFailed(
            this.plan.planHash,
            step.stepNumber,
            finalVerif.detail ?? 'Revalidação de schema final de Faturas falhou',
          );
          return false;
        }

        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Step 1: ALTER_SELECT_OPTIONS on Obrigações Mensais.Status.
   * Read-before-write, verifies baseline, preserves existing option IDs without color, appends 2 new options.
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

    // Check baseline options before proceeding
    const baselineCheck = StepStructuralVerifier.verifyAlterSelectOptions(statusProp, {
      requireBaselineOptions: true,
    });
    if (!baselineCheck.valid) {
      throw new Error(
        `SCHEMA_DRIFT_PRECONDITION_FAILED: ${baselineCheck.detail}. Abortando.`,
      );
    }

    // Check if already completely applied (idempotency check)
    const idempotentCheck = StepStructuralVerifier.verifyAlterSelectOptions(statusProp, {
      requireAllTargetOptions: true,
    });
    if (idempotentCheck.valid) {
      const liveOptions = statusProp.select?.options || [];
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

    // Build merged payload preserving existing IDs without color
    const rawOptions = statusProp.select?.options || statusProp.selectOptions || [];
    const liveOptions: Array<{ id?: string; name: string }> = Array.isArray(rawOptions)
      ? rawOptions.map((o: any) => (typeof o === 'string' ? { name: o } : o))
      : [];
    const liveNames = new Set(liveOptions.map((o) => o.name));
    const mergedPayloadOptions: Array<{ id?: string; name: string }> = [];
    for (const opt of liveOptions) {
      mergedPayloadOptions.push({
        ...(opt.id ? { id: opt.id } : {}),
        name: opt.name,
      });
    }

    if (!liveNames.has('Revisão Necessária')) mergedPayloadOptions.push({ name: 'Revisão Necessária' });
    if (!liveNames.has('Cancelada')) mergedPayloadOptions.push({ name: 'Cancelada' });

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

    // 3. Live Postcondition Verification (verifies all 7 target options)
    const verifiedDs = (await this.client.dataSources.retrieve({ data_source_id: dsId })) as any;
    const postStatusProp = verifiedDs.properties?.['Status'];
    const postCheck = StepStructuralVerifier.verifyAlterSelectOptions(postStatusProp, {
      requireAllTargetOptions: true,
    });

    if (!postCheck.valid) {
      const err = `POSTCONDITION_FAILED: ${postCheck.detail}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    const postOptions = postStatusProp.select?.options || [];
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
      const verif = StepStructuralVerifier.verifyCreateProperty(
        existingProp,
        step.sanitizedPayload,
        propName,
      );

      if (!verif.isCompatible) {
        const err = `SCHEMA_INCOMPATIBLE: ${verif.detail}`;
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
        detail: `Propriedade '${propName}' já existe com tipo e configuração compatíveis no Notion. Registrado como NO_OP_VERIFIED.`,
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

    const postCheck = StepStructuralVerifier.verifyCreateProperty(
      createdProp,
      step.sanitizedPayload,
      propName,
    );

    if (!postCheck.valid || !postCheck.isCompatible) {
      const err = `POSTCONDITION_FAILED: ${postCheck.detail ?? `Propriedade '${propName}' não encontrada ou incompatível`}`;
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
      // Search with filter.object = 'data_source' returns candidate Data Sources
      // Paginated search over data_sources to resolve parent databases
      let startCursor: string | undefined = undefined;
      let hasMore = true;
      const matchingDbs: Array<{ db: any; hasMarker: boolean }> = [];
      const seenDbIds = new Set<string>();

      while (hasMore) {
        // Any failure/timeout/rate limit on search must ABORT, never fall through to create
        const searchRes = (await this.client.search({
          query: 'Faturas / Ciclos de Cartão',
          filter: { value: 'data_source', property: 'object' },
          start_cursor: startCursor,
          page_size: 50,
        })) as any;

        const dataSources = searchRes.results || [];
        for (const ds of dataSources) {
          const parentDbId = ds.parent?.database_id;
          if (!parentDbId || seenDbIds.has(parentDbId)) continue;
          seenDbIds.add(parentDbId);

          const candidateDb = (await this.client.databases.retrieve({ database_id: parentDbId })) as any;
          if (!candidateDb || candidateDb.archived) continue;

          const normDbParent = (candidateDb.parent?.page_id || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const normTargetParent = parentPageId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const title = (candidateDb.title || []).map((t: any) => t.plain_text || t.text?.content || '').join('').trim();
          const isTitleMatch = title === 'Faturas / Ciclos de Cartão';

          if (normDbParent === normTargetParent && isTitleMatch) {
            const desc = (candidateDb.description || []).map((d: any) => d.plain_text || d.text?.content || '').join(' ');
            const expectedMarker = `MIGRATION_MARKER:${this.plan.planHash}:CARD_BILLS_V1`;
            if (desc.includes('CARD_BILLS_V1') && !desc.includes(expectedMarker)) {
              throw new Error(
                `FOREIGN_MIGRATION_PLAN_DATABASE: Database '${candidateDb.id}' possui marker de migração para CARD_BILLS_V1 com outro planHash. Abortando.`,
              );
            }
            const hasMarker = desc.includes(expectedMarker);
            matchingDbs.push({ db: candidateDb, hasMarker });
          }
        }

        hasMore = !!searchRes.has_more;
        startCursor = searchRes.next_cursor ?? undefined;
      }

      const withMarker = matchingDbs.filter((m) => m.hasMarker);
      const withoutMarker = matchingDbs.filter((m) => !m.hasMarker);

      if (withMarker.length === 1) {
        existingDbId = withMarker[0].db.id;
      } else if (withMarker.length > 1) {
        throw new Error(
          `AMBIGUOUS_DATABASE: Encontradas ${withMarker.length} bases candidatas com marker de migração sob a página-mãe. Abortando.`,
        );
      } else if (withoutMarker.length > 0) {
        // Same parent + same title WITHOUT marker: must throw AMBIGUOUS_OR_FOREIGN_DATABASE, never auto-adopt!
        throw new Error(
          `AMBIGUOUS_OR_FOREIGN_DATABASE: Database '${withoutMarker[0].db.id}' com o título 'Faturas / Ciclos de Cartão' já existe sob a página-mãe, mas não possui o marker obrigatório [${migrationMarker}]. Auto-adoção proibida.`,
        );
      }
    }

    if (existingDbId) {
      const liveDb = (await this.client.databases.retrieve({ database_id: existingDbId })) as any;
      const dbCheck = StepStructuralVerifier.verifyDatabase(liveDb, parentPageId, this.plan.planHash);

      if (dbCheck.valid) {
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
    const verif = StepStructuralVerifier.verifyDatabase(verifiedDb, parentPageId, this.plan.planHash);
    if (!verif.valid) {
      const err = `POSTCONDITION_FAILED: ${verif.detail ?? 'Database recém-criada inválida'}`;
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
   * Executes GET /v1/databases/{database.id}, validates data_sources, extracts unambiguous data_sources[0].id.
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
    const verif = StepStructuralVerifier.verifyResolveDataSource(db);

    if (!verif.valid || !verif.dataSourceId) {
      const err = `RESOLVE_DATA_SOURCE_FAILED: ${verif.detail ?? 'Falha ao resolver data source'}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    const resolvedDsId = verif.dataSourceId;

    // Hardened Step 53: Retrieve Data Source and structurally validate ALL initial properties from CREATE_DATABASE
    let billsDs: any;
    try {
      billsDs = (await this.client.dataSources.retrieve({ data_source_id: resolvedDsId })) as any;
    } catch (readErr: any) {
      const err = `RESOLVE_DATA_SOURCE_FAILED: Falha na leitura obrigatória do Data Source '${resolvedDsId}' para validação estrutural inicial: ${readErr?.message || String(readErr)}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    const initialProps = this.getExpectedCardBillsInitialProperties();
    const propsVerif = StepStructuralVerifier.verifyCardBillsInitialProperties(
      billsDs,
      initialProps,
    );

    if (!propsVerif.valid) {
      const err = `POSTCONDITION_FAILED: Validação estrutural de propriedades iniciais falhou no Step 53 [${propsVerif.reason}]: ${propsVerif.detail}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    this.journal.recordStepVerified(this.plan.planHash, step.stepNumber, resolvedDsId, {
      databaseId: dbId,
      resolvedDataSourceId: resolvedDsId,
      totalDataSources: db.data_sources.length,
      validatedInitialPropertiesCount: Object.keys(initialProps).length,
    });

    return {
      stepNumber: step.stepNumber,
      operation: step.operation,
      status: 'VERIFIED',
      targetDataSource: step.targetDataSource.name,
      createdId: resolvedDsId,
      detail: `Data Source ID resolvido com sucesso via GET /v1/databases/${dbId}: ${resolvedDsId} e ${Object.keys(initialProps).length} propriedades iniciais validadas estruturalmente.`,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Step 54: CREATE_DUAL_RELATION (Transações.Fatura Vinculada <-> Faturas.Lançamentos do Ciclo).
   * Verifies existing relation, creates if missing, confirms dual sync property on both sides.
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
    let txDs: any;
    let billsDs: any;
    try {
      txDs = (await this.client.dataSources.retrieve({ data_source_id: transactionsDsId })) as any;
      billsDs = (await this.client.dataSources.retrieve({ data_source_id: resolvedCardBillsDsId })) as any;
    } catch (readErr: any) {
      const err = `PRECONDITION_FAILED: Falha na leitura obrigatória dos Data Sources para dual relation: ${readErr?.message || String(readErr)}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    const existingRelProp = txDs.properties?.['Fatura Vinculada'];

    if (existingRelProp) {
      const verif = StepStructuralVerifier.verifyDualRelation(
        txDs,
        billsDs,
        resolvedCardBillsDsId,
        transactionsDsId,
      );

      if (verif.valid) {
        // Final verification of complete Faturas database schema (all 23 properties)
        const initialProps = this.getExpectedCardBillsInitialProperties();
        const finalVerif = StepStructuralVerifier.verifyCardBillsFinalSchema(
          billsDs,
          initialProps,
          transactionsDsId,
        );
        if (!finalVerif.valid) {
          const err = `POSTCONDITION_FAILED: Verificação final da base Faturas falhou pós-Step 54 (NO_OP) [${finalVerif.reason}]: ${finalVerif.detail}`;
          this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
          throw new Error(err);
        }

        this.journal.recordStepNoOp(this.plan.planHash, step.stepNumber, {
          operation: step.operation,
          targetDataSource: step.targetDataSource.name,
          targetDataSourceId: transactionsDsId,
          propertyName: 'Fatura Vinculada',
          existingId: existingRelProp.id,
          metadata: { targetDataSourceId: resolvedCardBillsDsId, dualPropertySynced: 'Lançamentos do Ciclo' },
        });

        return {
          stepNumber: step.stepNumber,
          operation: step.operation,
          status: 'NO_OP_VERIFIED',
          targetDataSource: step.targetDataSource.name,
          property: 'Fatura Vinculada',
          createdId: existingRelProp.id,
          detail: `Dual relation 'Fatura Vinculada' já existe exatamente vinculada a '${resolvedCardBillsDsId}' e schema final de 23 propriedades confirmado. Registrado como NO_OP_VERIFIED.`,
          durationMs: Date.now() - startTime,
        };
      }

      const err = `RELATION_CONFLICT: ${verif.detail}`;
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

    // 3. Postcondition Verification (validates BOTH Transações and Faturas sides)
    let verifiedTxDs: any;
    let verifiedBillsDs: any;
    try {
      verifiedTxDs = (await this.client.dataSources.retrieve({ data_source_id: transactionsDsId })) as any;
      verifiedBillsDs = (await this.client.dataSources.retrieve({ data_source_id: resolvedCardBillsDsId })) as any;
    } catch (readErr: any) {
      const err = `POSTCONDITION_FAILED: Falha na leitura obrigatória dos Data Sources para pós-verificação de dual relation: ${readErr?.message || String(readErr)}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    const postVerif = StepStructuralVerifier.verifyDualRelation(
      verifiedTxDs,
      verifiedBillsDs,
      resolvedCardBillsDsId,
      transactionsDsId,
    );

    if (!postVerif.valid) {
      const err = `POSTCONDITION_FAILED: ${postVerif.detail}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    // Final verification of complete Faturas database schema (initial properties + dual relation = exactly 23 properties)
    const initialProps = this.getExpectedCardBillsInitialProperties();
    const finalVerif = StepStructuralVerifier.verifyCardBillsFinalSchema(
      verifiedBillsDs,
      initialProps,
      transactionsDsId,
    );

    if (!finalVerif.valid) {
      const err = `POSTCONDITION_FAILED: Verificação final da base Faturas falhou pós-Step 54 [${finalVerif.reason}]: ${finalVerif.detail}`;
      this.journal.recordStepFailed(this.plan.planHash, step.stepNumber, err);
      throw new Error(err);
    }

    const createdRel = verifiedTxDs.properties?.['Fatura Vinculada'];
    this.journal.recordStepVerified(this.plan.planHash, step.stepNumber, createdRel?.id, {
      relationTarget: resolvedCardBillsDsId,
      syncedPropertyName: 'Lançamentos do Ciclo',
    });

    return {
      stepNumber: step.stepNumber,
      operation: step.operation,
      status: 'VERIFIED',
      targetDataSource: step.targetDataSource.name,
      property: 'Fatura Vinculada',
      createdId: createdRel?.id,
      detail: `Dual relation 'Fatura Vinculada' criada com sucesso, sincronizada com 'Lançamentos do Ciclo' e schema final de 23 propriedades confirmado (ID: ${createdRel?.id}).`,
      durationMs: Date.now() - startTime,
    };
  }
}
