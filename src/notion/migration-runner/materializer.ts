/**
 * Wire serialization and compatibility layer for Notion API payloads.
 *
 * Notion API (2026-03-11) requires relation property schemas to be defined as:
 * - Single relation: { data_source_id: string, single_property: {} }
 * - Dual relation:   { data_source_id: string, dual_property: { synced_property_name: string } }
 *
 * Legacy persisted plans store single relations as:
 *   { data_source_id: string, type: 'single_property' }
 *
 * This function converts any payload to the wire format required by Notion API while:
 * 1. Preserving complete immutability of input objects (the persisted plan remains unchanged).
 * 2. Preserving dual relations and non-relation properties without modification.
 * 3. Processing recursively, including inside initial_data_source.properties for CREATE_DATABASE.
 */
export function materializeNotionApiPayload<T = any>(payload: T): T {
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => materializeNotionApiPayload(item)) as unknown as T;
  }

  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(payload as Record<string, any>)) {
    if (key === 'relation' && value && typeof value === 'object' && !Array.isArray(value)) {
      const relObj = value as Record<string, any>;
      const targetId = relObj.data_source_id;

      if (relObj.dual_property) {
        result[key] = {
          data_source_id: targetId,
          dual_property: materializeNotionApiPayload(relObj.dual_property),
        };
      } else {
        result[key] = {
          data_source_id: targetId,
          single_property:
            relObj.single_property && typeof relObj.single_property === 'object'
              ? materializeNotionApiPayload(relObj.single_property)
              : {},
        };
      }
    } else {
      result[key] = materializeNotionApiPayload(value);
    }
  }

  return result as T;
}
