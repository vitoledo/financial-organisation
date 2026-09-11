import fs from 'fs';
import path from 'path';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT, DataSourceContract, PropertyContract } from '../domain/schema-contract';

export interface PropertyDiff {
  notionProperty: string;
  expectedType: string;
  actualType?: string;
  status: 'MATCH' | 'TYPE_MISMATCH' | 'MISSING' | 'EXTRA';
  authority: string;
  description: string;
}

export interface DataSourceDiff {
  envKey: string;
  title: string;
  dataSourceId?: string;
  isExisting: boolean;
  status: 'CONFIGURED_AND_VERIFIED' | 'MISSING_ENV_ID' | 'API_ERROR' | 'PROPOSED_NEW_DATABASE';
  properties: PropertyDiff[];
  errorMessage?: string;
}

export interface IntrospectionReport {
  timestampIso: string;
  notionApiVersion: string;
  totalDataSources: number;
  existingInspected: number;
  configuredCount: number;
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
      totalDataSources: Object.keys(TARGET_CONTRACT).length,
      existingInspected: 0,
      configuredCount: 0,
      results: {},
    };

    for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
      // If it's the 13th database, generate proposed schema without querying Notion!
      if (!contract.isExisting) {
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          isExisting: false,
          status: 'PROPOSED_NEW_DATABASE',
          properties: contract.properties.map((p) => ({
            notionProperty: p.notionProperty,
            expectedType: p.notionType,
            status: 'MISSING', // Must be created in Notion externally
            authority: p.authority,
            description: p.description,
          })),
        };
        continue;
      }

      report.existingInspected++;
      const dsId = envVars[contract.envKey]?.trim();

      if (!dsId) {
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          isExisting: true,
          status: 'MISSING_ENV_ID',
          properties: contract.properties.map((p) => ({
            notionProperty: p.notionProperty,
            expectedType: p.notionType,
            status: 'MISSING',
            authority: p.authority,
            description: p.description,
          })),
          errorMessage: `Variável de ambiente ${contract.envKey} não configurada.`,
        };
        continue;
      }

      report.configuredCount++;

      // If no API key or client is available, report as unverified
      if (!this.client) {
        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          dataSourceId: maskId(dsId),
          isExisting: true,
          status: 'API_ERROR',
          properties: contract.properties.map((p) => ({
            notionProperty: p.notionProperty,
            expectedType: p.notionType,
            status: 'MISSING',
            authority: p.authority,
            description: p.description,
          })),
          errorMessage: 'NOTION_API_KEY ausente. Introspecção remota não executada.',
        };
        continue;
      }

      // Query Notion Data Sources API
      try {
        const actualProperties = await this.fetchDataSourceProperties(dsId);
        const diff = this.compareProperties(contract, actualProperties);

        report.results[key] = {
          envKey: contract.envKey,
          title: contract.defaultTitle,
          dataSourceId: maskId(dsId),
          isExisting: true,
          status: 'CONFIGURED_AND_VERIFIED',
          properties: diff,
        };
      } catch (err) {
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
            status: 'MISSING',
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

  private compareProperties(
    contract: DataSourceContract,
    actual: Record<string, { type: string }>,
  ): PropertyDiff[] {
    const diffs: PropertyDiff[] = [];
    const expectedByName = new Map<string, PropertyContract>();

    for (const p of contract.properties) {
      expectedByName.set(p.notionProperty.toLowerCase(), p);
    }

    // Check expected properties
    for (const expected of contract.properties) {
      const matchKey = Object.keys(actual).find(
        (k) => k.trim().toLowerCase() === expected.notionProperty.toLowerCase(),
      );

      if (!matchKey) {
        diffs.push({
          notionProperty: expected.notionProperty,
          expectedType: expected.notionType,
          status: 'MISSING',
          authority: expected.authority,
          description: expected.description,
        });
      } else {
        const actualType = actual[matchKey].type;
        const isTypeMatch = actualType === expected.notionType;

        diffs.push({
          notionProperty: matchKey, // Actual casing from Notion
          expectedType: expected.notionType,
          actualType,
          status: isTypeMatch ? 'MATCH' : 'TYPE_MISMATCH',
          authority: expected.authority,
          description: expected.description,
        });
      }
    }

    // Check extra properties present in Notion but not in contract
    for (const [actualKey, actualProp] of Object.entries(actual)) {
      const isExpected = Object.keys(expectedByName).includes(actualKey.trim().toLowerCase());
      if (!isExpected) {
        diffs.push({
          notionProperty: actualKey,
          expectedType: '—',
          actualType: actualProp.type,
          status: 'EXTRA',
          authority: 'USUARIO',
          description: 'Propriedade personalizada existente no Notion (será preservada)',
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
    lines.push(`> **Data Sources Monitorados:** 12 existentes + 1 base proposta (Faturas / Ciclos)`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 1. Resumo Executivo da Verificação');
    lines.push('');
    lines.push('| Métrica | Valor |');
    lines.push('| :--- | :--- |');
    lines.push(`| Total de Data Sources Canônicos | ${report.totalDataSources} |`);
    lines.push(`| Bases Existentes Inspecionadas | ${report.existingInspected} |`);
    lines.push(`| Bases com ID Configurado no Ambiente | ${report.configuredCount} |`);
    lines.push('');

    // Check environment status
    const missingEnv = Object.values(report.results).filter((r) => r.status === 'MISSING_ENV_ID');
    const apiErrors = Object.values(report.results).filter((r) => r.status === 'API_ERROR');

    if (missingEnv.length > 0 || apiErrors.length > 0) {
      lines.push('> [!IMPORTANT]');
      lines.push('> **Atenção sobre Credenciais do Notion:**');
      if (missingEnv.length > 0) {
        lines.push(`> Existem **${missingEnv.length}** variáveis \`NOTION_DS_*\` pendentes de preenchimento no arquivo \`.env\`.`);
      }
      if (apiErrors.length > 0) {
        lines.push(`> ${apiErrors[0].errorMessage}`);
      }
      lines.push('> Para executar a introspecção remota ao vivo contra sua conta, preencha as variáveis em `.env` e rode `pnpm notion:check-schema`.');
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
        const statusBadge =
          p.status === 'MATCH'
            ? '✅ OK'
            : p.status === 'TYPE_MISMATCH'
              ? '❌ TIPO DIVERGENTE'
              : p.status === 'MISSING'
                ? '⚠️ AUSENTE'
                : 'ℹ️ EXTRA (PRESERVADA)';

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
    lines.push('3. Nas bases existentes, revise as propriedades marcadas como `⚠️ AUSENTE` ou `❌ TIPO DIVERGENTE` e adicione/ajuste-as.');
    lines.push('4. Execute novamente `pnpm notion:check-schema` para validar que todos os status convergiram para `✅ OK`.');
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

function maskId(id: string): string {
  if (!id || id.length < 8) return '****';
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}
