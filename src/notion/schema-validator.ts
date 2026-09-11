import fs from 'fs';
import path from 'path';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT, DataSourceContract, PropertyContract } from '../domain/schema-contract';

export type PropertyStatus =
  | 'EXACT_MATCH'
  | 'RENAME_CANDIDATE'
  | 'RENAME_TYPE_MISMATCH'
  | 'HEURISTIC_SUGGESTION'
  | 'TYPE_MISMATCH'
  | 'MISSING'
  | 'UNVERIFIED'
  | 'PROPOSED_TO_CREATE'
  | 'EXTRA_PRESERVE';

export interface PropertyDiff {
  notionProperty: string;
  expectedType: string;
  actualType?: string;
  status: PropertyStatus;
  authority: string;
  description: string;
  candidateName?: string;
}

export type DataSourceStatus =
  | 'CONFIGURED_AND_VERIFIED'
  | 'MISSING_ENV_ID'
  | 'UNVERIFIED_NO_KEY'
  | 'API_ERROR'
  | 'PROPOSED_NEW_DATABASE';

export interface DataSourceDiff {
  envKey: string;
  title: string;
  dataSourceId?: string;
  isExisting: boolean;
  status: DataSourceStatus;
  properties: PropertyDiff[];
  errorMessage?: string;
}

export interface IntrospectionReport {
  timestampIso: string;
  notionApiVersion: string;
  totalCanonical: number;      // 13
  expectedExisting: number;    // 12
  configuredCount: number;     // Number of existing bases with env var configured
  verifiedCount: number;       // ONLY Data Sources actually retrieved with success from Notion API
  failedCount: number;         // Existing bases that failed API or were missing token/env
  results: Record<string, DataSourceDiff>;
}

export class NotionSchemaValidator {
  private apiKey?: string;
  private client?: Client;
  private notionVersion: string = '2026-03-11';

  constructor(apiKey?: string, notionVersion: string = '2026-03-11') {
    this.apiKey = apiKey;
    this.notionVersion = notionVersion;
    if (this.apiKey) {
      this.client = new Client({
        auth: this.apiKey,
        notionVersion: this.notionVersion,
      });
    }
  }

  /**
   * Introspect all 12 existing Notion Data Sources.
   * NEVER queries NOTION_DS_CARD_BILLS (the 13th database).
   */
  async runIntrospection(envVars: Record<string, string | undefined>): Promise<IntrospectionReport> {
    const report: IntrospectionReport = {
      timestampIso: new Date().toISOString(),
      notionApiVersion: this.notionVersion,
      totalCanonical: Object.keys(TARGET_CONTRACT).length,
      expectedExisting: Object.values(TARGET_CONTRACT).filter((c) => c.isExisting).length,
      configuredCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      results: {},
    };

    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      // 13th database (Faturas / Ciclos) - proposed schema, never queried
      if (!contract.isExisting) {
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          isExisting: false,
          status: 'PROPOSED_NEW_DATABASE',
          properties: contract.properties.map((p) => ({
            notionProperty: p.notionProperty,
            expectedType: p.notionType,
            status: 'PROPOSED_TO_CREATE',
            authority: p.authority,
            description: p.description,
          })),
        };
        continue;
      }

      const dsId = envVars[contract.envKey]?.trim();

      if (!dsId) {
        report.failedCount++;
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          isExisting: true,
          status: 'MISSING_ENV_ID',
          properties: contract.properties.map((p) => ({
            notionProperty: p.notionProperty,
            expectedType: p.notionType,
            status: 'UNVERIFIED',
            authority: p.authority,
            description: p.description,
          })),
          errorMessage: `Variável de ambiente ${contract.envKey} não configurada.`,
        };
        continue;
      }

      report.configuredCount++;

      // If no API key or client is available, report as UNVERIFIED_NO_KEY
      if (!this.client) {
        report.failedCount++;
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          dataSourceId: maskId(dsId),
          isExisting: true,
          status: 'UNVERIFIED_NO_KEY',
          properties: contract.properties.map((p) => ({
            notionProperty: p.notionProperty,
            expectedType: p.notionType,
            status: 'UNVERIFIED',
            authority: p.authority,
            description: p.description,
          })),
          errorMessage: 'NOTION_API_KEY ausente no ambiente. Introspecção remota na API não executada.',
        };
        continue;
      }

      // Query Notion Data Sources API
      try {
        const actualProperties = await this.fetchDataSourceProperties(dsId);
        const diff = this.compareProperties(contract, actualProperties);

        report.verifiedCount++;
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          dataSourceId: maskId(dsId),
          isExisting: true,
          status: 'CONFIGURED_AND_VERIFIED',
          properties: diff,
        };
      } catch (err) {
        report.failedCount++;
        const errMsg = err instanceof Error ? err.message : String(err);
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          dataSourceId: maskId(dsId),
          isExisting: true,
          status: 'API_ERROR',
          properties: contract.properties.map((p) => ({
            notionProperty: p.notionProperty,
            expectedType: p.notionType,
            status: 'UNVERIFIED',
            authority: p.authority,
            description: p.description,
          })),
          errorMessage: `Erro ao consultar Data Source no Notion: ${errMsg}`,
        };
      }
    }

    return report;
  }

  private async fetchDataSourceProperties(
    dataSourceId: string,
  ): Promise<Record<string, { type: string }>> {
    if (!this.client) throw new Error('Notion client not initialized');

    // Use exclusively modern data sources API (notion.dataSources.retrieve)
    const response = (await this.client.dataSources.retrieve({
      data_source_id: dataSourceId,
    })) as { properties?: Record<string, { type: string }> };

    return response.properties ?? {};
  }

  public compareProperties(
    contract: DataSourceContract,
    actual: Record<string, { type: string }>,
  ): PropertyDiff[] {
    const diffs: PropertyDiff[] = [];
    const consumedActualKeys = new Set<string>();

    // -------------------------------------------------------------------------
    // Tier 1: Exact matches (case-insensitive & trimmed)
    // -------------------------------------------------------------------------
    const afterTier1Expected: PropertyContract[] = [];

    for (const expected of contract.properties) {
      const matchKey = Object.keys(actual).find(
        (k) =>
          !consumedActualKeys.has(k) &&
          normalizePropName(k) === normalizePropName(expected.notionProperty),
      );

      if (matchKey) {
        consumedActualKeys.add(matchKey);
        const actualType = actual[matchKey].type;
        const isTypeMatch = actualType === expected.notionType;

        diffs.push({
          notionProperty: matchKey,
          expectedType: expected.notionType,
          actualType,
          status: isTypeMatch ? 'EXACT_MATCH' : 'TYPE_MISMATCH',
          authority: expected.authority,
          description: expected.description,
        });
      } else {
        afterTier1Expected.push(expected);
      }
    }

    // -------------------------------------------------------------------------
    // Tier 2: Explicit alias matches (authoritative mapping from contract)
    // -------------------------------------------------------------------------
    const afterTier2Expected: PropertyContract[] = [];

    for (const expected of afterTier1Expected) {
      let matchedAliasKey: string | undefined;

      if (expected.aliases && expected.aliases.length > 0) {
        matchedAliasKey = Object.keys(actual).find(
          (k) =>
            !consumedActualKeys.has(k) &&
            expected.aliases!.some((alias) => normalizePropName(k) === normalizePropName(alias)),
        );
      }

      if (matchedAliasKey) {
        consumedActualKeys.add(matchedAliasKey);
        const actualType = actual[matchedAliasKey].type;
        const isTypeCompatible = actualType === expected.notionType;

        if (isTypeCompatible) {
          diffs.push({
            notionProperty: expected.notionProperty,
            expectedType: expected.notionType,
            actualType,
            status: 'RENAME_CANDIDATE',
            candidateName: matchedAliasKey,
            authority: expected.authority,
            description: `${expected.description} (Mapeado via alias explícito: "${matchedAliasKey}" com tipo compatível: ${actualType})`,
          });
        } else {
          diffs.push({
            notionProperty: expected.notionProperty,
            expectedType: expected.notionType,
            actualType,
            status: 'RENAME_TYPE_MISMATCH',
            candidateName: matchedAliasKey,
            authority: expected.authority,
            description: `${expected.description} (Mapeado via alias explícito: "${matchedAliasKey}", porém com tipo incompatível: esperado "${expected.notionType}", encontrado "${actualType}")`,
          });
        }
      } else {
        afterTier2Expected.push(expected);
      }
    }

    // -------------------------------------------------------------------------
    // Tier 3: Heuristic suggestion (advisory only, NOT authoritative)
    // -------------------------------------------------------------------------
    for (const expected of afterTier2Expected) {
      let bestMatchKey: string | undefined;
      let bestSimilarity = 0;

      for (const actualKey of Object.keys(actual)) {
        if (consumedActualKeys.has(actualKey)) continue;

        const sim = calculateSimilarity(expected.notionProperty, actualKey);
        if (sim >= 0.55 && sim > bestSimilarity) {
          bestSimilarity = sim;
          bestMatchKey = actualKey;
        }
      }

      if (bestMatchKey) {
        const actualType = actual[bestMatchKey].type;
        const simPercent = Math.round(bestSimilarity * 100);
        diffs.push({
          notionProperty: expected.notionProperty,
          expectedType: expected.notionType,
          actualType,
          status: 'HEURISTIC_SUGGESTION',
          candidateName: bestMatchKey,
          authority: expected.authority,
          description: `${expected.description} (Sugestão heurística não-autoritativa: "${bestMatchKey}" [${actualType}], similaridade: ${simPercent}%. Requer confirmação por alias explícito).`,
        });
        // Note: Heuristic does NOT consume bestMatchKey, preserving it for EXTRA_PRESERVE
      } else {
        diffs.push({
          notionProperty: expected.notionProperty,
          expectedType: expected.notionType,
          status: 'MISSING',
          authority: expected.authority,
          description: expected.description,
        });
      }
    }

    // -------------------------------------------------------------------------
    // Tier 4: All unconsumed properties in Notion are EXTRA_PRESERVE
    // -------------------------------------------------------------------------
    for (const [actualKey, actualProp] of Object.entries(actual)) {
      if (!consumedActualKeys.has(actualKey)) {
        diffs.push({
          notionProperty: actualKey,
          expectedType: '—',
          actualType: actualProp.type,
          status: 'EXTRA_PRESERVE',
          authority: 'USUARIO',
          description: 'Propriedade existente no Notion (preservada integralmente)',
        });
      }
    }

    return diffs;
  }

  /**
   * Generates the markdown manifesto in architecture/notion-schema-delta.md.
   * Ensures NO secret tokens or raw credentials are leaked.
   */
  generateMarkdownManifest(report: IntrospectionReport): string {
    const lines: string[] = [];

    lines.push('# Manifesto de Schema-Delta: Notion vs. Modelo de Domínio (Fase 0)');
    lines.push('');
    lines.push('> **Status:** Relatório Técnico de Introspecção e Conformidade de Schema');
    lines.push(`> **Data da Verificação:** ${report.timestampIso}`);
    lines.push(`> **Notion API Version:** \`${report.notionApiVersion}\``);
    lines.push(`> **Data Sources Canônicos:** ${report.totalCanonical} (${report.expectedExisting} esperados existentes + 1 base proposta)`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 1. Resumo Executivo da Verificação');
    lines.push('');
    lines.push('| Métrica de Data Sources | Valor |');
    lines.push('| :--- | :--- |');
    lines.push(`| Total de Data Sources Canônicos | ${report.totalCanonical} |`);
    lines.push(`| Bases Existentes Esperadas | ${report.expectedExisting} |`);
    lines.push(`| Bases Configuradas no Ambiente | ${report.configuredCount} |`);
    lines.push(`| Bases Verificadas com Sucesso na API | ${report.verifiedCount} |`);
    lines.push(`| Bases com Falha / Não Verificadas | ${report.failedCount} |`);
    lines.push(`| Base Proposta (a criar externamente) | 1 |`);
    lines.push('');

    const allProps = Object.values(report.results).flatMap((r) => r.properties);
    const totalExact = allProps.filter((p) => p.status === 'EXACT_MATCH').length;
    const totalRename = allProps.filter((p) => p.status === 'RENAME_CANDIDATE').length;
    const totalRenameMismatch = allProps.filter((p) => p.status === 'RENAME_TYPE_MISMATCH').length;
    const totalHeuristic = allProps.filter((p) => p.status === 'HEURISTIC_SUGGESTION').length;
    const totalTypeMismatch = allProps.filter((p) => p.status === 'TYPE_MISMATCH').length;
    const totalMissing = allProps.filter((p) => p.status === 'MISSING').length;
    const totalUnverified = allProps.filter((p) => p.status === 'UNVERIFIED').length;
    const totalProposed = allProps.filter((p) => p.status === 'PROPOSED_TO_CREATE').length;
    const totalExtra = allProps.filter((p) => p.status === 'EXTRA_PRESERVE').length;

    lines.push('| Status das Propriedades | Quantidade |');
    lines.push('| :--- | :--- |');
    lines.push(`| Correspondência Exata (EXACT_MATCH) | ${totalExact} |`);
    lines.push(`| Renomeações Mapeadas por Alias (RENAME_CANDIDATE) | ${totalRename} |`);
    lines.push(`| Mapeamento por Alias com Tipo Divergente (RENAME_TYPE_MISMATCH) | ${totalRenameMismatch} |`);
    lines.push(`| Sugestões Heurísticas Não-Autoritativas (HEURISTIC_SUGGESTION) | ${totalHeuristic} |`);
    lines.push(`| Divergências de Tipo em Nome Exato (TYPE_MISMATCH) | ${totalTypeMismatch} |`);
    lines.push(`| Propriedades Ausentes em Bases Verificadas (MISSING) | ${totalMissing} |`);
    lines.push(`| Propriedades Não Verificadas (UNVERIFIED / UNKNOWN) | ${totalUnverified} |`);
    lines.push(`| Propriedades a Criar na 13ª Base (PROPOSED_TO_CREATE) | ${totalProposed} |`);
    lines.push(`| Propriedades Adicionais Preservadas (EXTRA_PRESERVE) | ${totalExtra} |`);
    lines.push('');

    // Check environment status
    const missingEnv = Object.values(report.results).filter((r) => r.status === 'MISSING_ENV_ID');
    const noKey = Object.values(report.results).filter((r) => r.status === 'UNVERIFIED_NO_KEY');
    const apiErrors = Object.values(report.results).filter((r) => r.status === 'API_ERROR');

    if (missingEnv.length > 0 || noKey.length > 0 || apiErrors.length > 0) {
      lines.push('> [!IMPORTANT]');
      lines.push('> **Atenção sobre Introspecção e Credenciais:**');
      if (missingEnv.length > 0) {
        lines.push(`> Existem **${missingEnv.length}** variáveis \`NOTION_DS_*\` pendentes de preenchimento no arquivo \`.env\`.`);
      }
      if (noKey.length > 0) {
        lines.push(`> A variável \`NOTION_API_KEY\` não foi encontrada no ambiente. As ${noKey.length} bases configuradas foram marcadas como \`UNVERIFIED_NO_KEY\` e suas propriedades como \`UNVERIFIED\`.`);
      }
      if (apiErrors.length > 0) {
        lines.push(`> Ocorreram erros na API em **${apiErrors.length}** bases: ${apiErrors[0].errorMessage}`);
      }
      lines.push('> Para executar a introspecção remota ao vivo contra o Notion, defina `NOTION_API_KEY` em `.env` e rode `pnpm notion:check-schema`.');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('## 2. Diagnóstico Detalhado por Data Source');
    lines.push('');

    for (const [key, diff] of Object.entries(report.results)) {
      lines.push(`### ${diff.title} (\`${diff.envKey}\`)`);
      lines.push(`* **Status:** \`${diff.status}\``);
      if (diff.dataSourceId) lines.push(`* **Data Source ID (Parcial):** \`${diff.dataSourceId}\``);
      if (diff.errorMessage) lines.push(`* **Diagnóstico:** *${diff.errorMessage}*`);
      lines.push('');

      lines.push('| Propriedade | Tipo Esperado | Tipo no Notion | Status | Autoridade | Descrição / Observação |');
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');

      for (const p of diff.properties) {
        let statusBadge = '';
        switch (p.status) {
          case 'EXACT_MATCH':
            statusBadge = '✅ EXACT_MATCH';
            break;
          case 'RENAME_CANDIDATE':
            statusBadge = `🔄 RENAME_CANDIDATE (\`${p.candidateName}\`)`;
            break;
          case 'RENAME_TYPE_MISMATCH':
            statusBadge = `🔄❌ RENAME_TYPE_MISMATCH (\`${p.candidateName}\`)`;
            break;
          case 'HEURISTIC_SUGGESTION':
            statusBadge = `💡 HEURISTIC_SUGGESTION (\`${p.candidateName}\`) [Não-autoritativo]`;
            break;
          case 'TYPE_MISMATCH':
            statusBadge = `❌ TYPE_MISMATCH (esperado: ${p.expectedType}, no Notion: ${p.actualType})`;
            break;
          case 'MISSING':
            statusBadge = '⚠️ MISSING';
            break;
          case 'UNVERIFIED':
            statusBadge = '❓ UNVERIFIED';
            break;
          case 'PROPOSED_TO_CREATE':
            statusBadge = '🆕 PROPOSED_TO_CREATE';
            break;
          case 'EXTRA_PRESERVE':
            statusBadge = '🛡️ EXTRA_PRESERVE';
            break;
        }

        lines.push(
          `| \`${p.notionProperty}\` | \`${p.expectedType}\` | \`${p.actualType ?? '—'}\` | ${statusBadge} | \`${p.authority}\` | ${p.description} |`,
        );
      }

      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('## 3. Especificação Completa da 13ª Base: `Faturas / Ciclos de Cartão`');
    lines.push('');
    lines.push('Esta base **não existe atualmente** no seu Notion. Ela deve ser criada externamente para desacoplar faturas de fechamentos mensais.');
    lines.push('');
    lines.push('* **Nome Sugerido da Base:** `Faturas / Ciclos de Cartão`');
    lines.push('* **Variável de Ambiente Prevista:** `NOTION_DS_CARD_BILLS`');
    lines.push('');
    lines.push('| Propriedade a Criar | Tipo no Notion | Direção | Autoridade | Finalidade |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');

    const cardBillsContract = TARGET_CONTRACT.NOTION_DS_CARD_BILLS;
    for (const p of cardBillsContract.properties) {
      lines.push(
        `| \`${p.notionProperty}\` | \`${p.notionType}\` | \`${p.direction}\` | \`${p.authority}\` | ${p.description} |`,
      );
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 4. Instruções de Aplicação para o Usuário');
    lines.push('');
    lines.push('1. Para cada base com status `MISSING_ENV_ID`, copie o Data Source ID correspondente no Notion para o `.env`.');
    lines.push('2. Crie a 13ª base **Faturas / Ciclos de Cartão** no Notion seguindo as propriedades listadas na Seção 3.');
    lines.push('3. Nas bases existentes, revise as propriedades marcadas como `⚠️ MISSING`, `❌ TYPE_MISMATCH` ou `🔄 RENAME_CANDIDATE` e adicione/ajuste-as.');
    lines.push('4. Propriedades marcadas como `🛡️ EXTRA_PRESERVE` são mantidas integralmente no Notion.');
    lines.push('5. Execute novamente `pnpm notion:check-schema` para validar que todos os status convergiram para `✅ EXACT_MATCH`.');
    lines.push('');

    return lines.join('\n');
  }

  writeReportToMarkdown(report: IntrospectionReport, targetPath: string): void {
    const md = this.generateMarkdownManifest(report);
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, md, 'utf8');
  }
}

function normalizePropName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');      // remove spaces and punctuation
}

function calculateSimilarity(str1: string, str2: string): number {
  const norm1 = normalizePropName(str1);
  const norm2 = normalizePropName(str2);
  if (norm1 === norm2) return 1.0;
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    const minLen = Math.min(norm1.length, norm2.length);
    const maxLen = Math.max(norm1.length, norm2.length);
    return minLen / maxLen;
  }
  const m = norm1.length;
  const n = norm2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = norm1[i - 1] === norm2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : 1 - dp[m][n] / maxLen;
}

function maskId(id: string): string {
  if (!id || id.length < 8) return '****';
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}
