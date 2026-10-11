import { z, type ZodType } from 'zod';

type Node = Record<string, unknown>;

/**
 * The JSON Schema keywords the Gemini API reads in `responseJsonSchema` (ai.google.dev/api/generate-content; the same
 * list is in @google/genai 2.27.0 GenerateContentConfig.responseJsonSchema). Anything else is ignored by the model.
 */
export const GEMINI_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

// Combinators that cannot be kept as a note: dropping them would change which values are valid.
const UNREPRESENTABLE = ['allOf', 'not', 'if'] as const;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEnumValue = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number';

function convert(node: unknown, path: string): unknown {
  if (!isNode(node)) return node;
  for (const key of UNREPRESENTABLE) {
    if (key in node) throw new Error(`${key}（${path || '最上位'}）は Gemini の構造化出力で表せません`);
  }
  // A sub-schema with $ref may carry only other $-keywords.
  if (typeof node.$ref === 'string') {
    return Object.fromEntries(Object.entries(node).filter(([key]) => key.startsWith('$') && key !== '$schema' && GEMINI_SCHEMA_KEYWORDS.has(key)));
  }
  const out: Node = {};
  const notes: string[] = [];
  const note = (key: string, value: unknown): void => {
    notes.push(`${key}: ${JSON.stringify(value)}`);
  };
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue;
    if (key === 'const') {
      // A single-value enum is how Gemini constrains a constant (its enum takes strings and numbers only).
      if (isEnumValue(value) && !('enum' in node)) out.enum = [value];
      else if (!('enum' in node)) note(key, value);
      continue;
    }
    if (!GEMINI_SCHEMA_KEYWORDS.has(key) || (key === 'enum' && !(Array.isArray(value) && value.length > 0 && value.every(isEnumValue)))) {
      note(key, value);
      continue;
    }
    if ((key === 'properties' || key === '$defs') && isNode(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, convert(child, `${path}.${name}`)]));
    } else if ((key === 'anyOf' || key === 'oneOf' || key === 'prefixItems') && Array.isArray(value)) {
      out[key] = value.map((child, i) => convert(child, `${path}.${key}[${i}]`));
    } else if (key === 'items' || key === 'additionalProperties') {
      out[key] = convert(value, `${path}.${key}`);
    } else {
      out[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    }
  }
  if (notes.length > 0) {
    const own = typeof out.description === 'string' ? out.description : undefined;
    out.description = [own, `{${notes.join(', ')}}`].filter((p) => p !== undefined).join('\n\n');
  }
  return out;
}

/**
 * A JSON Schema rewritten for Gemini: keywords it does not read (minLength, pattern, exclusiveMinimum, …) are moved into
 * the description as `{keyword: value}` (as the Anthropic SDK does), a primitive `const` becomes a one-value `enum`, and
 * `$schema` is dropped. allOf / not / if cannot be expressed and throw.
 */
export function toGeminiJsonSchema(source: unknown): Node {
  const out = convert(source, '');
  if (!isNode(out)) throw new Error('JSON Schema の最上位がオブジェクトではありません');
  return out;
}

/**
 * The `responseJsonSchema` for a request's Zod schema (definitions inlined; only a recursive schema keeps $ref). The
 * model is constrained by it, but the answer is still parsed with the Zod schema. Throws when Zod or Gemini cannot
 * express the schema.
 */
export function geminiResponseSchema(schema: ZodType): Node {
  return toGeminiJsonSchema(z.toJSONSchema(schema));
}
