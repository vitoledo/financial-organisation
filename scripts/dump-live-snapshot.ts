import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { TARGET_CONTRACT } from '../src/domain/schema-contract';
import { NotionPropertySnapshot } from '../src/notion/schema-validator';

dotenv.config();

async function main() {
  const apiKey = process.env.NOTION_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('NOTION_API_KEY ausente no ambiente');
  }

  const client = new Client({
    auth: apiKey,
    notionVersion: '2026-03-11',
  });

  const snapshotMap: Record<string, Record<string, NotionPropertySnapshot>> = {};

  for (const [key, contract] of Object.entries(TARGET_CONTRACT)) {
    if (!contract.isExisting) continue;

    const dsId = process.env[contract.envKey]?.trim();
    if (!dsId) {
      throw new Error(`Variável ${contract.envKey} não encontrada`);
    }

    const response = (await client.dataSources.retrieve({
      data_source_id: dsId,
    })) as { properties?: Record<string, any> };

    const rawProps = response.properties ?? {};
    const baseSnapshot: Record<string, NotionPropertySnapshot> = {};

    for (const [name, prop] of Object.entries(rawProps)) {
      const type = prop.type ?? 'unknown';
      const snap: NotionPropertySnapshot = {
        name: prop.name ?? name,
        type,
      };

      if (type === 'select' && prop.select?.options) {
        snap.selectOptions = prop.select.options.map((o: any) => o.name);
      } else if (type === 'multi_select' && prop.multi_select?.options) {
        snap.selectOptions = prop.multi_select.options.map((o: any) => o.name);
      } else if (type === 'status' && prop.status?.options) {
        snap.selectOptions = prop.status.options.map((o: any) => o.name);
      } else if (type === 'relation' && prop.relation) {
        if (prop.relation.data_source_id) snap.relationDataSourceId = prop.relation.data_source_id;
        if (prop.relation.database_id) snap.relationDatabaseId = prop.relation.database_id;
        snap.relationType =
          prop.relation.type ?? (prop.relation.dual_property ? 'dual_property' : 'single_property');
        if (prop.relation.dual_property?.synced_property_name) {
          snap.syncedPropertyName = prop.relation.dual_property.synced_property_name;
        }
      }

      baseSnapshot[name] = snap;
    }

    snapshotMap[key] = baseSnapshot;
    console.log(`✓ Dumped ${key} (${contract.defaultTitle}): ${Object.keys(baseSnapshot).length} properties`);
  }

  const targetDir = path.resolve(process.cwd(), 'tests', 'fixtures');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const targetFile = path.resolve(targetDir, 'notion-live-schema.snapshot.json');
  fs.writeFileSync(targetFile, JSON.stringify(snapshotMap, null, 2) + '\n', 'utf8');
  console.log(`\n✅ Snapshot gravado com sucesso em: ${targetFile}`);
}

main().catch((err) => {
  console.error('Erro ao gerar snapshot:', err);
  process.exit(1);
});
