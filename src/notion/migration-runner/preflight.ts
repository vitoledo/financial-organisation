import crypto from 'crypto';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT } from '../../domain/schema-contract';
import { canonicalizeJson } from './hasher';
import {
  PreflightCheckResult,
  DataSourcePreflight,
  ParentPagePreflight,
  RelationTargetPreflight,
} from './types';

export class PreflightValidator {
  private client?: Client;
  private apiVersion: string;

  constructor(client?: Client, apiVersion: string = '2026-03-11') {
    this.client = client;
    this.apiVersion = apiVersion;
  }

  /**
   * Strictly read-only preflight check.
   * Validates the 12 existing Data Sources, parent page container, relation targets,
   * API version header, and records permissions as UNVERIFIED_UNTIL_APPLY.
   * Produces a sanitized live structural snapshot consumed directly by SchemaPlanner.
   * NEVER sends test mutations (no POST/PATCH/DELETE).
   */
  async runPreflight(envVars: Record<string, string | undefined> = process.env): Promise<PreflightCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const dataSources: DataSourcePreflight[] = [];
    const relationTargets: RelationTargetPreflight[] = [];
    const liveSnapshot: Record<string, Record<string, any>> = {};

    // 1. Validate the 12 existing Data Sources + 1 proposed
    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      if (!contract.isExisting) {
        dataSources.push({
          envKey: contract.envKey,
          name: contract.defaultTitle,
          accessible: false,
          status: 'PROPOSED_NEW',
        });
        continue;
      }

      const dsId = envVars[contract.envKey]?.trim();
      if (!dsId) {
        errors.push(`Variável de ambiente obrigatória ${contract.envKey} não definida.`);
        dataSources.push({
          envKey: contract.envKey,
          name: contract.defaultTitle,
          accessible: false,
          status: 'MISSING_ENV',
          errorMessage: `Variável ${contract.envKey} não configurada`,
        });
        continue;
      }

      if (!this.client) {
        dataSources.push({
          envKey: contract.envKey,
          name: contract.defaultTitle,
          id: dsId,
          accessible: false,
          status: 'API_ERROR',
          errorMessage: 'Cliente Notion não autenticado (NOTION_API_KEY ausente)',
        });
        continue;
      }

      try {
        const response = (await this.client.dataSources.retrieve({
          data_source_id: dsId,
        })) as { properties?: Record<string, any> };

        const rawProps = response.properties ?? {};
        const propCount = Object.keys(rawProps).length;
        const dsSnapshot: Record<string, any> = {};

        for (const [propName, propDef] of Object.entries(rawProps)) {
          const pType = propDef.type ?? 'unknown';
          const pEntry: Record<string, any> = {
            id: propDef.id,
            name: propDef.name ?? propName,
            type: pType,
          };

          if (pType === 'number' && propDef.number) {
            pEntry.number = {
              format: propDef.number.format,
            };
          } else if (pType === 'select' && propDef.select?.options) {
            pEntry.selectOptions = propDef.select.options.map((o: any) => ({
              id: o.id,
              name: o.name,
              color: o.color,
            }));
          } else if (pType === 'multi_select' && propDef.multi_select?.options) {
            pEntry.selectOptions = propDef.multi_select.options.map((o: any) => ({
              id: o.id,
              name: o.name,
              color: o.color,
            }));
          } else if (pType === 'status' && propDef.status?.options) {
            pEntry.selectOptions = propDef.status.options.map((o: any) => ({
              id: o.id,
              name: o.name,
              color: o.color,
            }));
          } else if (pType === 'relation' && propDef.relation) {
            pEntry.relationDataSourceId = propDef.relation.data_source_id;
            pEntry.relationType =
              propDef.relation.type ?? (propDef.relation.dual_property ? 'dual_property' : 'single_property');
            if (propDef.relation.dual_property) {
              pEntry.syncedPropertyName = propDef.relation.dual_property.synced_property_name;
              pEntry.syncedPropertyId = propDef.relation.dual_property.synced_property_id;
            }
          }

          dsSnapshot[propName] = pEntry;
        }

        liveSnapshot[contract.envKey] = dsSnapshot;

        dataSources.push({
          envKey: contract.envKey,
          name: contract.defaultTitle,
          id: dsId,
          accessible: true,
          status: 'VERIFIED',
          propertyCount: propCount,
        });
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Falha ao acessar Data Source ${contract.envKey} (${dsId}): ${msg}`);
        dataSources.push({
          envKey: contract.envKey,
          name: contract.defaultTitle,
          id: dsId,
          accessible: false,
          status: 'API_ERROR',
          errorMessage: msg,
        });
      }
    }

    // 2. Validate Parent Page Container for new databases
    const parentPageId =
      envVars.NOTION_PARENT_PAGE_ID?.trim() ?? envVars.NOTION_WORKSPACE_PAGE_ID?.trim();

    let parentPage: ParentPagePreflight = {
      pageId: parentPageId,
      status: parentPageId ? 'CONFIGURED' : 'NOT_CONFIGURED',
      accessible: false,
      note: parentPageId
        ? 'Página-mãe configurada.'
        : 'NOTION_PARENT_PAGE_ID não configurado. Obrigatório para criação de novas bases (Faturas) em modo apply.',
    };

    if (!parentPageId) {
      warnings.push(
        'NOTION_PARENT_PAGE_ID não configurado. O plano dry-run utilizará placeholder para a criação de Faturas.',
      );
    } else if (this.client) {
      try {
        await this.client.pages.retrieve({ page_id: parentPageId });
        parentPage.accessible = true;
        parentPage.note = 'Página-mãe validada e acessível via API.';
      } catch (err: any) {
        parentPage.status = 'ERROR';
        parentPage.accessible = false;
        parentPage.note = `Erro ao validar página-mãe (${parentPageId}): ${err.message}`;
        warnings.push(`Página-mãe (${parentPageId}) inacessível: ${err.message}`);
      }
    }

    // 3. Validate Relation Targets
    for (const [sourceKey, contract] of Object.entries(TARGET_CONTRACT)) {
      for (const prop of contract.properties) {
        if (prop.notionType === 'relation' && prop.relationTargetEnvKey) {
          const targetContract = TARGET_CONTRACT[prop.relationTargetEnvKey];
          const targetEnvKey = prop.relationTargetEnvKey;
          const targetId = envVars[targetEnvKey]?.trim();

          const isTargetProposed = targetContract && !targetContract.isExisting;

          if (isTargetProposed) {
            relationTargets.push({
              fromDataSource: contract.defaultTitle,
              property: prop.notionProperty,
              targetEnvKey,
              targetDataSourceId: '<PROPOSED_IN_STEP>',
              valid: true,
              note: 'Alvo é nova base proposta (Faturas / Ciclos de Cartão). ID será resolvido em runtime.',
            });
          } else if (targetId) {
            const targetDs = dataSources.find((d) => d.envKey === targetEnvKey);
            const isAccessible = targetDs?.accessible ?? false;
            relationTargets.push({
              fromDataSource: contract.defaultTitle,
              property: prop.notionProperty,
              targetEnvKey,
              targetDataSourceId: targetId,
              valid: isAccessible,
              note: isAccessible
                ? 'Target Data Source validado com sucesso'
                : 'Target Data Source configurado porém inacessível',
            });
            if (!isAccessible) {
              warnings.push(
                `Relation '${prop.notionProperty}' aponta para ${targetEnvKey}, que não pôde ser verificado.`,
              );
            }
          } else {
            relationTargets.push({
              fromDataSource: contract.defaultTitle,
              property: prop.notionProperty,
              targetEnvKey,
              valid: false,
              note: `Variável ${targetEnvKey} ausente para relation ${prop.notionProperty}`,
            });
            errors.push(`Target ID não configurado para relation ${contract.defaultTitle}.${prop.notionProperty}`);
          }
        }
      }
    }

    const verifiedCount = dataSources.filter((d) => d.status === 'VERIFIED').length;
    const isValid = errors.length === 0 && verifiedCount === 12;
    const liveSnapshotSha256 = crypto
      .createHash('sha256')
      .update(canonicalizeJson(liveSnapshot), 'utf8')
      .digest('hex');

    return {
      valid: isValid,
      apiVersion: this.apiVersion,
      dataSources,
      parentPage,
      relationTargets,
      liveSnapshot,
      liveSnapshotSha256,
      permissions: 'UNVERIFIED_UNTIL_APPLY',
      warnings,
      errors,
    };
  }
}
