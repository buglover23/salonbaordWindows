import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import { z, type ZodType } from 'zod';

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * Removes one `key: <json>` entry from the `{...}` block the SDK appends to a description for keywords it does not
 * send. Returns the description unchanged when the block is not where the SDK puts it.
 */
function withoutEntry(description: string | undefined, own: string | undefined, entry: string): string | undefined {
  if (description === undefined) return undefined;
  const prefix = own === undefined ? '' : `${own}\n\n`;
  if (!description.startsWith(prefix)) return description;
  const block = description.slice(prefix.length);
  if (!block.startsWith('{') || !block.endsWith('}')) return description;
  const entries = block.slice(1, -1);
  let rest: string;
  if (entries === entry) rest = '';
  else if (entries.startsWith(`${entry}, `)) rest = entries.slice(entry.length + 2);
  else if (entries.endsWith(`, ${entry}`)) rest = entries.slice(0, -(entry.length + 2));
  else if (entries.includes(`, ${entry}, `)) rest = entries.replace(`, ${entry}, `, ', ');
  else return description;
  const parts = [own, rest === '' ? undefined : `{${rest}}`].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function restoreKeyword(source: Node, out: Node, key: 'enum' | 'const'): void {
  if (!(key in source)) return;
  const value = source[key];
  const ok = key === 'enum' ? Array.isArray(value) && value.length > 0 && value.every(isPrimitive) : isPrimitive(value);
  if (!ok) return;
  out[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
  const own = typeof source.description === 'string' ? source.description : undefined;
  const description = withoutEntry(typeof out.description === 'string' ? out.description : undefined, own, `${key}: ${JSON.stringify(value)}`);
  if (description === undefined) delete out.description;
  else out.description = description;
}

/**
 * Walks the JSON Schema Zod produced (`source`) and the SDK's transformed copy (`out`) side by side ($defs,
 * properties, items, anyOf/oneOf, allOf) and puts primitive `enum` and `const` back into `out`, which the SDK's
 * transform (0.131.0) only mentions in descriptions although the API enforces them. Mutates `out`.
 */
export function restoreEnumAndConst(source: unknown, out: unknown): void {
  if (!isNode(source) || !isNode(out)) return;
  if (isNode(source.$defs) && isNode(out.$defs)) {
    for (const [name, def] of Object.entries(source.$defs)) restoreEnumAndConst(def, out.$defs[name]);
  }
  if (typeof source.$ref === 'string') return;
  if (isNode(source.properties) && isNode(out.properties)) {
    for (const [name, prop] of Object.entries(source.properties)) restoreEnumAndConst(prop, out.properties[name]);
  }
  if (isNode(source.items)) restoreEnumAndConst(source.items, out.items);
  const variants = Array.isArray(source.anyOf) ? source.anyOf : Array.isArray(source.oneOf) ? source.oneOf : undefined;
  if (variants !== undefined && Array.isArray(out.anyOf)) variants.forEach((v, i) => restoreEnumAndConst(v, (out.anyOf as unknown[])[i]));
  if (Array.isArray(source.allOf) && Array.isArray(out.allOf)) source.allOf.forEach((v, i) => restoreEnumAndConst(v, (out.allOf as unknown[])[i]));
  restoreKeyword(source, out, 'enum');
  restoreKeyword(source, out, 'const');
}

/**
 * The JSON Schema sent as `output_config.format.schema`: the SDK's strict transform (additionalProperties false,
 * unsupported bounds such as minimum/maxItems moved into descriptions) with `enum` and `const` kept as real
 * constraints. The response is still parsed with the Zod schema afterwards. Throws when Zod cannot represent the schema.
 */
export function structuredOutputSchema(schema: ZodType): Record<string, unknown> {
  const source = z.toJSONSchema(schema, { reused: 'ref' }) as Node;
  const out = transformJSONSchema(source) as Node;
  restoreEnumAndConst(source, out);
  return out;
}
